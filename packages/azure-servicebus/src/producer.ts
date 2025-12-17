/**
 * Azure Service Bus Producer Implementation
 */

import { ServiceBusClient, type ServiceBusSender, type ServiceBusMessage } from '@azure/service-bus';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
  generateUUID,
} from '@anyq/core';
import type { ServiceBusProducerConfig } from './config.js';

/**
 * Azure Service Bus Producer
 *
 * Publishes messages to Azure Service Bus queues or topics
 */
export class ServiceBusProducer<T = unknown> extends BaseProducer<T> {
  private client: ServiceBusClient | null = null;
  private sender: ServiceBusSender | null = null;
  private readonly serviceBusConfig: ServiceBusProducerConfig;

  constructor(config: ServiceBusProducerConfig) {
    super(config);
    this.serviceBusConfig = config;

    // Validate config - must have either queue or topic
    if (!config.queue && !config.topic) {
      throw new Error('ServiceBusProducerConfig must specify either queue or topic');
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
      const { connection, queue, topic } = this.serviceBusConfig;

      this.client = new ServiceBusClient(connection.connectionString);

      // Create sender for queue or topic
      const entityPath = topic?.name ?? queue?.name;
      if (!entityPath) {
        throw new Error('No queue or topic name specified');
      }

      this.sender = this.client.createSender(entityPath);

      this._connected = true;
      this.logger.info('Azure Service Bus producer connected', {
        entity: entityPath,
        type: topic ? 'topic' : 'queue',
      });
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
      if (this.sender) {
        await this.sender.close();
        this.sender = null;
      }

      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      this._connected = false;
      this.logger.info('Azure Service Bus producer disconnected');
    } catch (error) {
      this.logger.error('Error during disconnect', { error });
    }
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.sender) {
      throw new ConnectionError('Producer not connected');
    }

    const messageId = generateUUID();

    try {
      const serializedBody = this.serializer.serialize(body);

      const message: ServiceBusMessage = {
        messageId,
        body: serializedBody,
        contentType: 'application/json',
        sessionId: options?.groupId, // Map groupId to sessionId
        partitionKey: options?.key, // Map key to partitionKey
        correlationId: options?.correlationId,
        replyTo: options?.replyTo,
        timeToLive: options?.ttlMs,
        applicationProperties: options?.headers as Record<string, string | number | boolean | Date>,
      };

      // Add scheduled enqueue time if delay is specified
      if (options?.delaySeconds) {
        message.scheduledEnqueueTimeUtc = new Date(Date.now() + options.delaySeconds * 1000);
      }

      await this.sender.sendMessages(message);

      this.logger.debug('Message published', {
        messageId,
        sessionId: options?.groupId,
        partitionKey: options?.key,
      });

      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.sender) {
      throw new ConnectionError('Producer not connected');
    }

    const messageIds: string[] = [];

    try {
      // Create a batch
      const batch = await this.sender.createMessageBatch();

      for (const { body, options } of messages) {
        const messageId = generateUUID();
        messageIds.push(messageId);

        const serializedBody = this.serializer.serialize(body);

        const message: ServiceBusMessage = {
          messageId,
          body: serializedBody,
          contentType: 'application/json',
          sessionId: options?.groupId,
          partitionKey: options?.key,
          correlationId: options?.correlationId,
          replyTo: options?.replyTo,
          timeToLive: options?.ttlMs,
          applicationProperties: options?.headers as Record<string, string | number | boolean | Date>,
        };

        if (options?.delaySeconds) {
          message.scheduledEnqueueTimeUtc = new Date(Date.now() + options.delaySeconds * 1000);
        }

        const added = batch.tryAddMessage(message);
        if (!added) {
          // Batch is full, send it and create a new one
          await this.sender.sendMessages(batch);
          const newBatch = await this.sender.createMessageBatch();
          newBatch.tryAddMessage(message);
        }
      }

      // Send remaining messages
      if (batch.count > 0) {
        await this.sender.sendMessages(batch);
      }

      this.logger.debug('Batch published', {
        count: messageIds.length,
      });

      return messageIds;
    } catch (error) {
      throw new PublishError('Failed to publish batch', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Flush pending messages
   */
  async flush(): Promise<void> {
    // Azure Service Bus sends immediately, no flush needed
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.sender) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      // Check if sender is open
      const entityPath = this.serviceBusConfig.topic?.name ?? this.serviceBusConfig.queue?.name;

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          entity: entityPath,
          type: this.serviceBusConfig.topic ? 'topic' : 'queue',
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
 * Create an Azure Service Bus producer instance
 */
export function createServiceBusProducer<T = unknown>(
  config: ServiceBusProducerConfig
): ServiceBusProducer<T> {
  return new ServiceBusProducer<T>(config);
}
