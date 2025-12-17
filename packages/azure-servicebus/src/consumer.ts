/**
 * Azure Service Bus Consumer Implementation
 */

import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
  type ProcessErrorArgs,
} from '@azure/service-bus';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  ConnectionError,
} from '@anyq/core';
import type { ServiceBusConsumerConfig } from './config.js';
import { SERVICEBUS_DEFAULTS } from './config.js';

/**
 * Azure Service Bus Consumer
 *
 * Consumes messages from Azure Service Bus queues or topic subscriptions
 */
export class ServiceBusConsumer<T = unknown> extends BaseConsumer<T> {
  private client: ServiceBusClient | null = null;
  private receiver: ServiceBusReceiver | null = null;
  private readonly serviceBusConfig: ServiceBusConsumerConfig;
  private subscription: { close: () => Promise<void> } | null = null;

  constructor(config: ServiceBusConsumerConfig) {
    super(config);
    this.serviceBusConfig = {
      ...config,
      receiver: {
        ...SERVICEBUS_DEFAULTS.receiver,
        ...config.receiver,
      },
      maxConcurrentCalls: config.maxConcurrentCalls ?? SERVICEBUS_DEFAULTS.maxConcurrentCalls,
    };

    // Validate config - must have either queue or subscription
    if (!config.queue && !config.subscription) {
      throw new Error('ServiceBusConsumerConfig must specify either queue or subscription');
    }
  }

  /**
   * Connect to Azure Service Bus
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const { connection, queue, subscription, receiver } = this.serviceBusConfig;

      this.client = new ServiceBusClient(connection.connectionString);

      // Create receiver for queue or subscription
      const receiveMode = receiver?.receiveMode === 'receiveAndDelete' ? 'receiveAndDelete' : 'peekLock';

      if (subscription) {
        this.receiver = this.client.createReceiver(
          subscription.topicName,
          subscription.subscriptionName,
          {
            receiveMode,
            maxAutoLockRenewalDurationInMs: receiver?.maxAutoLockRenewalDurationMs,
            subQueueType: receiver?.subQueueType,
          }
        );
        this.logger.info('Azure Service Bus consumer connected', {
          topic: subscription.topicName,
          subscription: subscription.subscriptionName,
          receiveMode,
        });
      } else if (queue) {
        this.receiver = this.client.createReceiver(queue.name, {
          receiveMode,
          maxAutoLockRenewalDurationInMs: receiver?.maxAutoLockRenewalDurationMs,
          subQueueType: receiver?.subQueueType,
        });
        this.logger.info('Azure Service Bus consumer connected', {
          queue: queue.name,
          receiveMode,
        });
      }

      this._connected = true;
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to Azure Service Bus',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from Azure Service Bus
   */
  async disconnect(): Promise<void> {
    try {
      if (this.subscription) {
        await this.subscription.close();
        this.subscription = null;
      }

      if (this.receiver) {
        await this.receiver.close();
        this.receiver = null;
      }

      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      this._connected = false;
      this.logger.info('Azure Service Bus consumer disconnected');
    } catch (error) {
      this.logger.error('Error during disconnect', { error });
    }
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    _options?: SubscribeOptions
  ): Promise<void> {
    if (!this.receiver) {
      throw new ConnectionError('Consumer not connected');
    }

    const processMessage = async (sbMessage: ServiceBusReceivedMessage): Promise<void> => {
      if (this._paused) {
        // Abandon message when paused to release lock
        await this.receiver?.abandonMessage(sbMessage);
        return;
      }

      try {
        const message = this.convertMessage(sbMessage);
        await handler(message);
      } catch (error) {
        this.logger.error('Error processing message', { error });
        // Message will be abandoned/dead-lettered by the SDK based on settings
      }
    };

    const processError = async (args: ProcessErrorArgs): Promise<void> => {
      this.logger.error('Service Bus receiver error', {
        error: args.error.message,
        errorSource: args.errorSource,
      });
    };

    this.subscription = this.receiver.subscribe(
      {
        processMessage,
        processError,
      },
      {
        maxConcurrentCalls: this.serviceBusConfig.maxConcurrentCalls,
        autoCompleteMessages: false, // Manual ack
      }
    );

    this.logger.info('Subscribed to messages', {
      maxConcurrentCalls: this.serviceBusConfig.maxConcurrentCalls,
    });
  }

  /**
   * Subscribe to messages in batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.receiver) {
      throw new ConnectionError('Consumer not connected');
    }

    const batchSize = options?.batchSize ?? 10;
    const batchTimeout = options?.batchTimeout ?? 5000;

    // Use polling for batch mode
    const poll = async (): Promise<void> => {
      while (this._connected && !this._paused) {
        try {
          const sbMessages = await this.receiver!.receiveMessages(batchSize, {
            maxWaitTimeInMs: batchTimeout,
          });

          if (sbMessages.length > 0) {
            try {
              const messages = sbMessages.map(msg => this.convertMessage(msg));
              await handler(messages);
            } catch (error) {
              this.logger.error('Error processing batch', { error });
              // Abandon all messages
              for (const msg of sbMessages) {
                await this.receiver?.abandonMessage(msg);
              }
            }
          }
        } catch (error) {
          this.logger.error('Error receiving batch', { error });
          await new Promise(resolve => setTimeout(resolve, 1000)); // Back off
        }
      }
    };

    // Start polling in background
    poll().catch(err => {
      this.logger.error('Batch polling error', { error: err });
    });

    this.logger.info('Subscribed to messages (batch mode)', {
      batchSize,
      batchTimeout,
    });
  }

  /**
   * Convert Service Bus message to IMessage format
   */
  private convertMessage(sbMessage: ServiceBusReceivedMessage) {
    let body: T;

    if (typeof sbMessage.body === 'string') {
      try {
        body = JSON.parse(sbMessage.body) as T;
      } catch {
        body = sbMessage.body as unknown as T;
      }
    } else {
      body = sbMessage.body as T;
    }

    // Extract headers from application properties
    const headers: Record<string, string | Buffer | undefined> = {};
    if (sbMessage.applicationProperties) {
      for (const [key, value] of Object.entries(sbMessage.applicationProperties)) {
        if (Buffer.isBuffer(value)) {
          headers[key] = value;
        } else if (value !== undefined && value !== null) {
          headers[key] = String(value);
        }
      }
    }

    const messageId = sbMessage.messageId?.toString() ?? `sb-${Date.now()}`;

    return createMessage<T>({
      id: messageId,
      body,
      key: sbMessage.partitionKey,
      headers,
      timestamp: sbMessage.enqueuedTimeUtc ?? new Date(),
      deliveryAttempt: sbMessage.deliveryCount ?? 1,
      metadata: {
        provider: 'azure-servicebus',
        azureServicebus: {
          sequenceNumber: sbMessage.sequenceNumber !== undefined
            ? BigInt(sbMessage.sequenceNumber.toString())
            : BigInt(0),
          enqueuedTime: sbMessage.enqueuedTimeUtc ?? new Date(),
          lockedUntil: sbMessage.lockedUntilUtc,
          sessionId: sbMessage.sessionId,
          partitionKey: sbMessage.partitionKey,
        },
      },
      raw: sbMessage,
      onAck: async () => {
        await this.receiver?.completeMessage(sbMessage);
        this.logger.debug('Message completed', { messageId });
      },
      onNack: async () => {
        await this.receiver?.abandonMessage(sbMessage);
        this.logger.debug('Message abandoned', { messageId });
      },
      onExtendDeadline: async (seconds: number) => {
        await this.receiver?.renewMessageLock(sbMessage);
        this.logger.debug('Message lock renewed', { messageId, seconds });
      },
    });
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.receiver) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      const entityPath = this.serviceBusConfig.subscription
        ? `${this.serviceBusConfig.subscription.topicName}/${this.serviceBusConfig.subscription.subscriptionName}`
        : this.serviceBusConfig.queue?.name;

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          entity: entityPath,
          type: this.serviceBusConfig.subscription ? 'subscription' : 'queue',
          paused: this._paused,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        connected: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Create an Azure Service Bus consumer instance
 */
export function createServiceBusConsumer<T = unknown>(
  config: ServiceBusConsumerConfig
): ServiceBusConsumer<T> {
  return new ServiceBusConsumer<T>(config);
}
