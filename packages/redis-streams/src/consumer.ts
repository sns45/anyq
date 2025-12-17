/**
 * @fileoverview Redis Streams consumer implementation
 * @module @anyq/redis-streams/consumer
 */

import Redis from 'ioredis';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  type IMessage,
  type MessageHeaders,
  ConnectionError,
} from '@anyq/core';
import type { RedisStreamsConfig, ConsumerGroupConfig } from './config.js';

/**
 * Parsed stream entry
 */
interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/**
 * Default subscribe options
 */
const DEFAULT_SUBSCRIBE_OPTIONS: Required<SubscribeOptions> = {
  fromBeginning: false,
  fromTimestamp: undefined as unknown as Date,
  concurrency: 1,
  autoAck: true,
  batchSize: 10,
  batchTimeout: 1000,
};

/**
 * Redis Streams consumer implementation
 *
 * Consumes messages from Redis Streams using consumer groups.
 *
 * @example
 * ```typescript
 * const consumer = new RedisStreamsConsumer({
 *   driver: 'redis-streams',
 *   streamName: 'orders',
 *   consumerGroup: {
 *     groupName: 'order-processors',
 *     consumerName: 'consumer-1',
 *   },
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 * ```
 */
export class RedisStreamsConsumer<T = unknown> extends BaseConsumer<T> {
  private client: Redis | null = null;
  private readonly streamName: string;
  private readonly groupConfig: ConsumerGroupConfig;
  private readonly blockTimeout: number;
  private readonly claimTimeout: number;
  private readonly minIdleTime: number;
  private running = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RedisStreamsConfig) {
    super(config);
    this.streamName = config.streamName;
    this.groupConfig = config.consumerGroup ?? {
      groupName: 'default-group',
      consumerName: `consumer-${Date.now()}`,
    };
    this.blockTimeout = config.blockTimeout ?? 5000;
    this.claimTimeout = config.claimTimeout ?? 30000;
    this.minIdleTime = config.minIdleTime ?? 10000;
  }

  /**
   * Connect to Redis and create consumer group
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

      // Create consumer group if needed
      if (this.groupConfig.autoCreate !== false) {
        await this.ensureConsumerGroup();
      }

      this._connected = true;
      this.logger.info('Redis Streams consumer connected', {
        stream: this.streamName,
        group: this.groupConfig.groupName,
        consumer: this.groupConfig.consumerName,
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

    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    try {
      await this.client.quit();
    } catch {
      // Ignore quit errors
    }

    this.client = null;
    this._connected = false;
    this.logger.info('Redis Streams consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.client) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    const poll = async () => {
      if (!this.running || this._paused || !this.client) {
        return;
      }

      try {
        // First, try to claim pending messages
        if (this.claimTimeout > 0) {
          await this.processPendingMessages(handler, opts);
        }

        // Then read new messages
        const entries = await this.readMessages(1);

        for (const entry of entries) {
          if (!this.running || this._paused) break;

          const message = this.createWrappedMessage(entry);

          try {
            this.emit('message', message);
            await handler(message);

            if (opts.autoAck) {
              await message.ack();
            }
          } catch (error) {
            this.logger.error('Error processing message', {
              messageId: entry.id,
              error: error instanceof Error ? error.message : String(error),
            });

            this.emit(
              'error',
              error instanceof Error ? error : new Error(String(error))
            );

            // Let the message become pending for reclaim
          }
        }
      } catch (error) {
        this.logger.error('Error in poll loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Start polling
    this.pollInterval = setInterval(poll, 100);
    await poll(); // Initial poll

    this.logger.info('Subscribed to stream', {
      stream: this.streamName,
      group: this.groupConfig.groupName,
    });
  }

  /**
   * Subscribe to message batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.client) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    const poll = async () => {
      if (!this.running || this._paused || !this.client) {
        return;
      }

      try {
        const entries = await this.readMessages(opts.batchSize);

        if (entries.length === 0) {
          return;
        }

        const messages = entries.map((entry) => this.createWrappedMessage(entry));

        try {
          await handler(messages);

          if (opts.autoAck) {
            for (const message of messages) {
              await message.ack();
            }
          }
        } catch (error) {
          this.logger.error('Error processing batch', {
            count: messages.length,
            error: error instanceof Error ? error.message : String(error),
          });

          this.emit(
            'error',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      } catch (error) {
        this.logger.error('Error in batch poll loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    this.pollInterval = setInterval(poll, opts.batchTimeout);
    this.logger.info('Subscribed to stream (batch)', {
      stream: this.streamName,
      group: this.groupConfig.groupName,
    });
  }

  /**
   * Pause consumption
   */
  async pause(): Promise<void> {
    await super.pause();
    this.running = false;
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    await super.resume();
    this.running = true;
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

      // Get consumer group info
      const groups = await this.client.xinfo('GROUPS', this.streamName).catch(() => []);
      const groupInfo = (groups as unknown[][]).find(
        (g) => g[g.indexOf('name') + 1] === this.groupConfig.groupName
      );

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          stream: this.streamName,
          group: this.groupConfig.groupName,
          consumer: this.groupConfig.consumerName,
          pending: groupInfo ? groupInfo[groupInfo.indexOf('pending') + 1] : 0,
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

  /**
   * Get the underlying Redis client (for testing)
   */
  getClient(): Redis | null {
    return this.client;
  }

  /**
   * Ensure the consumer group exists
   */
  private async ensureConsumerGroup(): Promise<void> {
    if (!this.client) return;

    try {
      const startId = this.groupConfig.startId ?? '0';
      await this.client.xgroup(
        'CREATE',
        this.streamName,
        this.groupConfig.groupName,
        startId,
        'MKSTREAM'
      );
      this.logger.debug('Consumer group created', {
        group: this.groupConfig.groupName,
        stream: this.streamName,
      });
    } catch (error) {
      // Group already exists
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }

  /**
   * Read messages from the stream
   */
  private async readMessages(count: number): Promise<StreamEntry[]> {
    if (!this.client) return [];

    try {
      const result = await this.client.xreadgroup(
        'GROUP',
        this.groupConfig.groupName,
        this.groupConfig.consumerName,
        'COUNT',
        String(count),
        'BLOCK',
        String(this.blockTimeout),
        'STREAMS',
        this.streamName,
        '>'
      );

      if (!result) return [];

      // Parse the result
      const entries: StreamEntry[] = [];
      for (const [, messages] of result as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          const fieldMap: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
          }
          entries.push({ id, fields: fieldMap });
        }
      }

      return entries;
    } catch (error) {
      this.logger.error('Error reading messages', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Process pending messages (auto-claim)
   */
  private async processPendingMessages(
    handler: MessageHandler<T>,
    opts: Required<SubscribeOptions>
  ): Promise<void> {
    if (!this.client) return;

    try {
      // Use XAUTOCLAIM to claim and get pending messages
      const result = await this.client.xautoclaim(
        this.streamName,
        this.groupConfig.groupName,
        this.groupConfig.consumerName,
        String(this.minIdleTime),
        '0-0',
        'COUNT',
        '5'
      );

      if (!result || !Array.isArray(result) || result.length < 2) return;

      const messages = result[1] as [string, string[]][];
      for (const [id, fields] of messages) {
        if (!this.running || this._paused) break;

        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }

        const message = this.createWrappedMessage({ id, fields: fieldMap });

        try {
          await handler(message);
          if (opts.autoAck) {
            await message.ack();
          }
        } catch (error) {
          this.logger.error('Error processing pending message', {
            messageId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      // XAUTOCLAIM might fail on older Redis versions
      this.logger.debug('XAUTOCLAIM failed, skipping pending processing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create a wrapped message from stream entry
   */
  private createWrappedMessage(entry: StreamEntry): IMessage<T> {
    const body = this.serializer.deserialize(entry.fields.body || '{}');
    const headers: MessageHeaders = entry.fields.headers
      ? JSON.parse(entry.fields.headers)
      : {};

    return createMessage({
      id: entry.id,
      body,
      key: entry.fields.key,
      headers,
      timestamp: new Date(parseInt(entry.id.split('-')[0], 10)),
      deliveryAttempt: 1,
      metadata: {
        provider: 'redis-streams',
        redisStreams: {
          stream: this.streamName,
          entryId: entry.id,
          consumerGroup: this.groupConfig.groupName,
          consumer: this.groupConfig.consumerName,
        },
      },
      raw: entry,
      onAck: async () => {
        if (this.client) {
          await this.client.xack(
            this.streamName,
            this.groupConfig.groupName,
            entry.id
          );
          this.logger.debug('Message acknowledged', { messageId: entry.id });
        }
      },
      onNack: async (requeue = true) => {
        // For Redis Streams, nack doesn't have a direct equivalent
        // If requeue=false, we remove from pending list
        if (!requeue && this.client) {
          await this.client.xack(
            this.streamName,
            this.groupConfig.groupName,
            entry.id
          );
        }
        this.logger.debug('Message nacked', { messageId: entry.id, requeue });
      },
    });
  }
}
