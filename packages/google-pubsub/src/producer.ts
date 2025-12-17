/**
 * Google Cloud Pub/Sub Producer Implementation
 */

import { PubSub, type Topic } from '@google-cloud/pubsub';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
  generateUUID,
} from '@anyq/core';
import type { PubSubProducerConfig } from './config.js';
import { PUBSUB_DEFAULTS } from './config.js';

/**
 * Google Cloud Pub/Sub Producer
 *
 * Publishes messages to Google Cloud Pub/Sub topics
 */
export class PubSubProducer<T = unknown> extends BaseProducer<T> {
  private client: PubSub | null = null;
  private topic: Topic | null = null;
  private readonly pubsubConfig: PubSubProducerConfig;

  constructor(config: PubSubProducerConfig) {
    super(config);
    this.pubsubConfig = {
      ...config,
      topic: {
        ...PUBSUB_DEFAULTS.topic,
        ...config.topic,
      },
      batching: {
        ...PUBSUB_DEFAULTS.batching,
        ...config.batching,
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
      const { connection, topic: topicConfig, batching } = this.pubsubConfig;

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

      // Get or create topic
      this.topic = this.client.topic(topicConfig.name, {
        batching: {
          maxMessages: batching?.maxMessages ?? 100,
          maxBytes: batching?.maxBytes ?? 1024 * 1024,
          maxMilliseconds: batching?.maxMilliseconds ?? 10,
        },
        messageOrdering: topicConfig.enableMessageOrdering ?? false,
      });

      if (topicConfig.autoCreate) {
        await this.ensureTopic();
      }

      this._connected = true;
      this.logger.info('Pub/Sub producer connected', {
        projectId: connection.projectId,
        topic: topicConfig.name,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to Pub/Sub',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Ensure the topic exists
   */
  private async ensureTopic(): Promise<void> {
    if (!this.topic) {
      throw new Error('Topic not initialized');
    }

    try {
      const [exists] = await this.topic.exists();
      if (!exists) {
        await this.topic.create();
        this.logger.info('Topic created', { topic: this.pubsubConfig.topic.name });
      }
    } catch (error) {
      // Ignore if topic already exists (race condition)
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
    if (this.topic) {
      await this.topic.flush();
      this.topic = null;
    }

    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    this._connected = false;
    this.logger.info('Pub/Sub producer disconnected');
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.topic) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const serializedBody = this.serializer.serialize(body);
      const data = Buffer.isBuffer(serializedBody)
        ? serializedBody
        : Buffer.from(serializedBody);

      // Build attributes from headers
      const attributes: Record<string, string> = {};
      if (options?.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          if (value !== undefined) {
            attributes[key] = Buffer.isBuffer(value) ? value.toString() : String(value);
          }
        }
      }

      // Add message ID for tracking
      const messageId = generateUUID();
      attributes['anyq-message-id'] = messageId;

      const messageOptions: {
        data: Buffer;
        attributes: Record<string, string>;
        orderingKey?: string;
      } = {
        data,
        attributes,
      };

      // Set ordering key if message ordering is enabled
      if (options?.orderingKey) {
        messageOptions.orderingKey = options.orderingKey;
      } else if (options?.key) {
        messageOptions.orderingKey = options.key;
      }

      const publishedId = await this.topic.publishMessage(messageOptions);

      this.logger.debug('Message published', {
        messageId: publishedId,
        topic: this.pubsubConfig.topic.name,
      });

      return publishedId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages in batch
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.topic) {
      throw new ConnectionError('Producer not connected');
    }

    const results: string[] = [];

    try {
      // Pub/Sub handles batching internally, so we can publish individually
      for (const { body, options } of messages) {
        const messageId = await this.publish(body, options);
        results.push(messageId);
      }

      // Ensure all messages are sent
      await this.topic.flush();

      this.logger.debug('Batch published', {
        count: results.length,
        topic: this.pubsubConfig.topic.name,
      });

      return results;
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
    if (this.topic) {
      await this.topic.flush();
    }
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.topic) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      // Check if topic exists
      const [exists] = await this.topic.exists();

      return {
        healthy: exists,
        connected: this._connected,
        latencyMs: Date.now() - start,
        details: {
          topic: this.pubsubConfig.topic.name,
          projectId: this.pubsubConfig.connection.projectId,
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
 * Create a Pub/Sub producer instance
 */
export function createPubSubProducer<T = unknown>(
  config: PubSubProducerConfig
): PubSubProducer<T> {
  return new PubSubProducer<T>(config);
}
