/**
 * @fileoverview Redis Streams producer implementation
 * @module @anyq/redis-streams/producer
 */

import Redis from 'ioredis';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { RedisStreamsConfig } from './config.js';

/**
 * Redis Streams producer implementation
 *
 * Publishes messages to Redis Streams using XADD.
 *
 * @example
 * ```typescript
 * const producer = new RedisStreamsProducer({
 *   driver: 'redis-streams',
 *   streamName: 'orders',
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' });
 * await producer.disconnect();
 * ```
 */
export class RedisStreamsProducer<T = unknown> extends BaseProducer<T> {
  private client: Redis | null = null;
  private readonly streamName: string;
  private readonly maxLen: number;
  private readonly approximate: boolean;

  constructor(config: RedisStreamsConfig) {
    super(config);
    this.streamName = config.streamName;
    this.maxLen = config.maxStreamLength ?? 0;
    this.approximate = config.approximateTrimming ?? true;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const redisConfig = (this.config as RedisStreamsConfig).redis ?? {};

      if (redisConfig.url) {
        this.client = new Redis(redisConfig.url, {
          keyPrefix: redisConfig.keyPrefix,
          connectionName: redisConfig.connectionName,
          lazyConnect: true,
        });
      } else {
        this.client = new Redis({
          host: redisConfig.host ?? 'localhost',
          port: redisConfig.port ?? 6379,
          password: redisConfig.password,
          db: redisConfig.db ?? 0,
          username: redisConfig.username,
          tls: redisConfig.tls ? {} : undefined,
          keyPrefix: redisConfig.keyPrefix,
          connectionName: redisConfig.connectionName,
          lazyConnect: true,
        });
      }

      await this.client.connect();
      this._connected = true;
      this.logger.info('Redis Streams producer connected', {
        stream: this.streamName,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to Redis',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.client) {
      return;
    }

    try {
      await this.client.quit();
    } catch {
      // Ignore quit errors, connection might already be closed
    }

    this.client = null;
    this._connected = false;
    this.logger.info('Redis Streams producer disconnected');
  }

  /**
   * Publish a single message to the stream
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.client) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      // Serialize body to JSON
      const serializedData = this.serializer.serialize(body);
      const serialized = Buffer.isBuffer(serializedData)
        ? serializedData.toString('utf8')
        : serializedData;

      // Build fields array for XADD
      const fields: string[] = ['body', serialized];

      if (options?.key) {
        fields.push('key', options.key);
      }

      if (options?.headers) {
        fields.push('headers', JSON.stringify(options.headers));
      }

      // Build XADD command
      let messageId: string | null;

      if (this.maxLen > 0) {
        // With trimming
        const trimOp = this.approximate ? '~' : '=';
        messageId = await this.client.xadd(
          this.streamName,
          'MAXLEN',
          trimOp,
          String(this.maxLen),
          '*',
          ...fields
        );
      } else {
        // Without trimming
        messageId = await this.client.xadd(this.streamName, '*', ...fields);
      }

      if (!messageId) {
        throw new Error('Failed to add message to stream');
      }

      this.logger.debug('Message published', {
        messageId,
        stream: this.streamName,
        key: options?.key,
      });

      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages in a pipeline
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.client) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const pipeline = this.client.pipeline();

      for (const { body, options } of messages) {
        const serializedData = this.serializer.serialize(body);
        const serialized = Buffer.isBuffer(serializedData)
          ? serializedData.toString('utf8')
          : serializedData;
        const fields: string[] = ['body', serialized];

        if (options?.key) {
          fields.push('key', options.key);
        }

        if (options?.headers) {
          fields.push('headers', JSON.stringify(options.headers));
        }

        if (this.maxLen > 0) {
          const trimOp = this.approximate ? '~' : '=';
          pipeline.xadd(
            this.streamName,
            'MAXLEN',
            trimOp,
            String(this.maxLen),
            '*',
            ...fields
          );
        } else {
          pipeline.xadd(this.streamName, '*', ...fields);
        }
      }

      const results = await pipeline.exec();
      const messageIds: string[] = [];

      if (results) {
        for (const [err, result] of results) {
          if (err) {
            throw err;
          }
          if (result) {
            messageIds.push(String(result));
          }
        }
      }

      this.logger.debug('Batch published', {
        count: messageIds.length,
        stream: this.streamName,
      });

      return messageIds;
    } catch (error) {
      throw new PublishError('Failed to publish batch', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this.client || !this._connected) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      await this.client.ping();
      const info = await this.client.xinfo('STREAM', this.streamName).catch(() => null);

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          stream: this.streamName,
          length: info ? (info as unknown[])[(info as unknown[]).indexOf('length') + 1] : 0,
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

  /**
   * Get the underlying Redis client (for testing)
   */
  getClient(): Redis | null {
    return this.client;
  }
}
