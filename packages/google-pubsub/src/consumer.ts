/**
 * Google Cloud Pub/Sub Consumer Implementation
 */

import {
  PubSub,
  type Subscription,
  type Message as PubSubMessage,
} from '@google-cloud/pubsub';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  ConnectionError,
} from '@anyq/core';
import type { PubSubConsumerConfig } from './config.js';
import { PUBSUB_DEFAULTS } from './config.js';

/**
 * Google Cloud Pub/Sub Consumer
 *
 * Consumes messages from Google Cloud Pub/Sub subscriptions
 */
export class PubSubConsumer<T = unknown> extends BaseConsumer<T> {
  private client: PubSub | null = null;
  private subscription: Subscription | null = null;
  private readonly pubsubConfig: PubSubConsumerConfig;

  constructor(config: PubSubConsumerConfig) {
    super(config);
    this.pubsubConfig = {
      ...config,
      subscription: {
        ...PUBSUB_DEFAULTS.subscription,
        ...config.subscription,
      },
    };
  }

  /**
   * Connect to Google Cloud Pub/Sub
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const { connection, subscription: subConfig } = this.pubsubConfig;

      // Configure client options
      const clientOptions: {
        projectId: string;
        keyFilename?: string;
        apiEndpoint?: string;
      } = {
        projectId: connection.projectId,
      };

      if (connection.keyFilename) {
        clientOptions.keyFilename = connection.keyFilename;
      }

      if (connection.apiEndpoint) {
        clientOptions.apiEndpoint = connection.apiEndpoint;
      }

      // Set emulator environment variable if needed
      if (connection.emulatorMode && connection.apiEndpoint) {
        process.env.PUBSUB_EMULATOR_HOST = connection.apiEndpoint.replace('http://', '');
      }

      this.client = new PubSub(clientOptions);

      // Get subscription
      this.subscription = this.client.subscription(subConfig.name, {
        flowControl: {
          maxMessages: subConfig.flowControl?.maxMessages ?? PUBSUB_DEFAULTS.flowControl.maxMessages,
          allowExcessMessages: false,
        },
        ackDeadline: subConfig.ackDeadlineSeconds ?? PUBSUB_DEFAULTS.subscription.ackDeadlineSeconds,
      });

      if (subConfig.autoCreate) {
        await this.ensureSubscription();
      }

      this._connected = true;
      this.logger.info('Pub/Sub consumer connected', {
        projectId: connection.projectId,
        subscription: subConfig.name,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to Pub/Sub',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Ensure the subscription exists
   */
  private async ensureSubscription(): Promise<void> {
    if (!this.subscription || !this.client) {
      throw new Error('Subscription not initialized');
    }

    const { subscription: subConfig, topicName } = this.pubsubConfig;

    try {
      const [exists] = await this.subscription.exists();
      if (!exists) {
        if (!topicName) {
          throw new Error('Topic name required for auto-creating subscription');
        }

        // Ensure topic exists first
        const topic = this.client.topic(topicName);
        const [topicExists] = await topic.exists();
        if (!topicExists) {
          await topic.create();
          this.logger.info('Topic created', { topic: topicName });
        }

        // Create subscription
        const [createdSub] = await topic.createSubscription(subConfig.name, {
          ackDeadlineSeconds: subConfig.ackDeadlineSeconds,
          deadLetterPolicy: subConfig.deadLetterPolicy ? {
            deadLetterTopic: `projects/${this.pubsubConfig.connection.projectId}/topics/${subConfig.deadLetterPolicy.deadLetterTopic}`,
            maxDeliveryAttempts: subConfig.deadLetterPolicy.maxDeliveryAttempts,
          } : undefined,
          retryPolicy: subConfig.retryPolicy ? {
            minimumBackoff: { seconds: subConfig.retryPolicy.minimumBackoff },
            maximumBackoff: { seconds: subConfig.retryPolicy.maximumBackoff },
          } : undefined,
        });

        this.subscription = createdSub;
        this.logger.info('Subscription created', { subscription: subConfig.name });
      }
    } catch (error) {
      // Ignore if subscription already exists (race condition)
      const err = error as { code?: number };
      if (err.code !== 6) { // 6 = ALREADY_EXISTS
        throw error;
      }
    }
  }

  /**
   * Disconnect from Pub/Sub
   */
  async disconnect(): Promise<void> {
    if (this.subscription) {
      await this.subscription.close();
      this.subscription = null;
    }

    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    this._connected = false;
    this.logger.info('Pub/Sub consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    _options?: SubscribeOptions
  ): Promise<void> {
    if (!this.subscription) {
      throw new ConnectionError('Consumer not connected');
    }

    this.subscription.on('message', async (message: PubSubMessage) => {
      if (this._paused) {
        // Nack to re-deliver later when paused
        message.nack();
        return;
      }

      try {
        const convertedMessage = this.convertMessage(message);
        await handler(convertedMessage);
      } catch (error) {
        this.logger.error('Error processing message', { error });
        // Don't ack - message will be redelivered
      }
    });

    this.subscription.on('error', (error: Error) => {
      this.logger.error('Subscription error', { error: error.message });
      this.emit('error', error);
    });

    this.logger.info('Subscribed to messages', {
      subscription: this.pubsubConfig.subscription.name,
    });
  }

  /**
   * Subscribe to messages in batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.subscription) {
      throw new ConnectionError('Consumer not connected');
    }

    const batchSize = options?.batchSize ?? 10;
    const batchTimeout = options?.batchTimeout ?? 5000;
    let batch: PubSubMessage[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const processBatch = async () => {
      if (batch.length === 0) return;

      const currentBatch = [...batch];
      batch = [];

      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }

      try {
        const messages = currentBatch.map(msg => this.convertMessage(msg));
        await handler(messages);
      } catch (error) {
        this.logger.error('Error processing batch', { error });
        // Nack all messages in the batch
        for (const msg of currentBatch) {
          msg.nack();
        }
      }
    };

    this.subscription.on('message', async (message: PubSubMessage) => {
      if (this._paused) {
        message.nack();
        return;
      }

      batch.push(message);

      if (batch.length >= batchSize) {
        await processBatch();
      } else if (!batchTimer) {
        batchTimer = setTimeout(() => processBatch(), batchTimeout);
      }
    });

    this.subscription.on('error', (error: Error) => {
      this.logger.error('Subscription error', { error: error.message });
      this.emit('error', error);
    });

    this.logger.info('Subscribed to messages (batch mode)', {
      subscription: this.pubsubConfig.subscription.name,
      batchSize,
      batchTimeout,
    });
  }

  /**
   * Convert Pub/Sub message to IMessage format
   */
  private convertMessage(message: PubSubMessage) {
    const data = message.data.toString('utf8');
    let body: T;

    try {
      body = JSON.parse(data) as T;
    } catch {
      body = data as unknown as T;
    }

    // Extract headers from attributes
    const headers: Record<string, string | Buffer | undefined> = {};
    if (message.attributes) {
      for (const [key, value] of Object.entries(message.attributes)) {
        headers[key] = value;
      }
    }

    const messageId = message.id;
    const publishTime = message.publishTime;

    return createMessage<T>({
      id: messageId,
      body,
      headers,
      timestamp: publishTime,
      deliveryAttempt: message.deliveryAttempt ?? 1,
      metadata: {
        provider: 'google-pubsub',
        googlePubsub: {
          subscription: this.pubsubConfig.subscription.name,
          ackId: message.ackId,
          publishTime,
          orderingKey: message.orderingKey,
        },
      },
      raw: message,
      onAck: async () => {
        message.ack();
        this.logger.debug('Message acknowledged', { messageId });
      },
      onNack: async () => {
        message.nack();
        this.logger.debug('Message negatively acknowledged', { messageId });
      },
      onExtendDeadline: async (_seconds: number) => {
        // Pub/Sub modifyAckDeadline requires subscription-level operation
        // For simplicity, we just log the extension request
        this.logger.debug('Message deadline extension requested', { messageId });
      },
    });
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.subscription) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      // Check if subscription exists
      const [exists] = await this.subscription.exists();

      return {
        healthy: exists,
        connected: this._connected,
        latencyMs: Date.now() - start,
        details: {
          subscription: this.pubsubConfig.subscription.name,
          projectId: this.pubsubConfig.connection.projectId,
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
 * Create a Pub/Sub consumer instance
 */
export function createPubSubConsumer<T = unknown>(
  config: PubSubConsumerConfig
): PubSubConsumer<T> {
  return new PubSubConsumer<T>(config);
}
