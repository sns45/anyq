/**
 * @fileoverview Kafka consumer implementation
 * @module @anyq/kafka/consumer
 */

import {
  Kafka,
  type Consumer,
  type EachMessagePayload,
  type EachBatchPayload,
  type SASLOptions,
} from 'kafkajs';
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
import type { KafkaConfig, KafkaConsumerGroupConfig } from './config.js';

/**
 * Default subscribe options
 */
const DEFAULT_SUBSCRIBE_OPTIONS: Required<SubscribeOptions> = {
  fromBeginning: false,
  fromTimestamp: undefined as unknown as Date,
  concurrency: 1,
  autoAck: true,
  batchSize: 100,
  batchTimeout: 1000,
};

/**
 * Kafka consumer implementation
 *
 * Consumes messages from Kafka topics using consumer groups.
 *
 * @example
 * ```typescript
 * const consumer = new KafkaConsumer({
 *   driver: 'kafka',
 *   topic: 'orders',
 *   kafka: { brokers: ['localhost:9092'] },
 *   consumerGroup: { groupId: 'order-processors' },
 * });
 *
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 * ```
 */
export class KafkaConsumer<T = unknown> extends BaseConsumer<T> {
  private kafka: Kafka | null = null;
  private consumer: Consumer | null = null;
  private readonly topic: string;
  private readonly groupConfig: KafkaConsumerGroupConfig;
  private running = false;

  constructor(config: KafkaConfig) {
    super(config);
    this.topic = config.topic;
    this.groupConfig = config.consumerGroup ?? {
      groupId: 'anyq-consumer-group',
    };
  }

  /**
   * Connect to Kafka
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const kafkaConfig = (this.config as KafkaConfig).kafka;
      const saslConfig = (this.config as KafkaConfig).sasl;
      const sslConfig = (this.config as KafkaConfig).ssl;

      this.kafka = new Kafka({
        clientId: kafkaConfig.clientId ?? 'anyq-consumer',
        brokers: kafkaConfig.brokers,
        connectionTimeout: kafkaConfig.connectionTimeout,
        authenticationTimeout: kafkaConfig.authenticationTimeout,
        requestTimeout: kafkaConfig.requestTimeout,
        sasl: saslConfig as SASLOptions | undefined,
        ssl: sslConfig?.enabled
          ? {
              rejectUnauthorized: sslConfig.rejectUnauthorized ?? true,
              ca: sslConfig.ca,
              cert: sslConfig.cert,
              key: sslConfig.key,
            }
          : undefined,
      });

      this.consumer = this.kafka.consumer({
        groupId: this.groupConfig.groupId,
        sessionTimeout: this.groupConfig.sessionTimeout,
        rebalanceTimeout: this.groupConfig.rebalanceTimeout,
        heartbeatInterval: this.groupConfig.heartbeatInterval,
        maxBytesPerPartition: this.groupConfig.maxBytesPerPartition,
        minBytes: this.groupConfig.minBytes,
        maxBytes: this.groupConfig.maxBytes,
        maxWaitTimeInMs: this.groupConfig.maxWaitTimeInMs,
      });

      await this.consumer.connect();
      this._connected = true;
      this.logger.info('Kafka consumer connected', {
        topic: this.topic,
        groupId: this.groupConfig.groupId,
        brokers: kafkaConfig.brokers,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to Kafka',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.consumer) {
      return;
    }

    this.running = false;

    try {
      await this.consumer.stop();
      await this.consumer.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    this.consumer = null;
    this.kafka = null;
    this._connected = false;
    this.logger.info('Kafka consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.consumer) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    await this.consumer.subscribe({
      topic: this.topic,
      fromBeginning: opts.fromBeginning,
    });

    await this.consumer.run({
      autoCommit: this.groupConfig.autoCommit ?? opts.autoAck,
      autoCommitInterval: this.groupConfig.autoCommitInterval,
      autoCommitThreshold: this.groupConfig.autoCommitThreshold ?? undefined,
      eachMessage: async (payload: EachMessagePayload) => {
        if (!this.running || this._paused) {
          return;
        }

        const message = this.createWrappedMessage(payload);

        try {
          this.emit('message', message);
          await handler(message);

          if (!opts.autoAck && !(this.groupConfig.autoCommit ?? true)) {
            await message.ack();
          }
        } catch (error) {
          this.logger.error('Error processing message', {
            topic: payload.topic,
            partition: payload.partition,
            offset: payload.message.offset,
            error: error instanceof Error ? error.message : String(error),
          });

          this.emit(
            'error',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
    });

    this.logger.info('Subscribed to topic', {
      topic: this.topic,
      groupId: this.groupConfig.groupId,
    });
  }

  /**
   * Subscribe to message batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.consumer) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    await this.consumer.subscribe({
      topic: this.topic,
      fromBeginning: opts.fromBeginning,
    });

    await this.consumer.run({
      autoCommit: this.groupConfig.autoCommit ?? opts.autoAck,
      autoCommitInterval: this.groupConfig.autoCommitInterval,
      autoCommitThreshold: this.groupConfig.autoCommitThreshold ?? undefined,
      eachBatch: async (payload: EachBatchPayload) => {
        if (!this.running || this._paused) {
          return;
        }

        const messages: IMessage<T>[] = [];

        for (const kafkaMessage of payload.batch.messages) {
          const message = this.createWrappedMessage({
            topic: payload.batch.topic,
            partition: payload.batch.partition,
            message: kafkaMessage,
            heartbeat: payload.heartbeat,
            pause: payload.pause,
          });
          messages.push(message);
        }

        try {
          await handler(messages);

          if (!opts.autoAck && !(this.groupConfig.autoCommit ?? true)) {
            // Commit the batch offset
            await payload.commitOffsetsIfNecessary();
          }
        } catch (error) {
          this.logger.error('Error processing batch', {
            topic: payload.batch.topic,
            partition: payload.batch.partition,
            count: messages.length,
            error: error instanceof Error ? error.message : String(error),
          });

          this.emit(
            'error',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
    });

    this.logger.info('Subscribed to topic (batch)', {
      topic: this.topic,
      groupId: this.groupConfig.groupId,
    });
  }

  /**
   * Pause consumption
   */
  async pause(): Promise<void> {
    await super.pause();
    this.running = false;
    if (this.consumer) {
      this.consumer.pause([{ topic: this.topic }]);
    }
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    await super.resume();
    this.running = true;
    if (this.consumer) {
      this.consumer.resume([{ topic: this.topic }]);
    }
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this.kafka || !this.consumer || !this._connected) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          topic: this.topic,
          groupId: this.groupConfig.groupId,
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
   * Get the underlying Kafka client (for testing)
   */
  getKafka(): Kafka | null {
    return this.kafka;
  }

  /**
   * Get the underlying consumer (for testing)
   */
  getConsumer(): Consumer | null {
    return this.consumer;
  }

  /**
   * Create a wrapped message from Kafka message
   */
  private createWrappedMessage(payload: EachMessagePayload): IMessage<T> {
    const { topic, partition, message } = payload;
    const value = message.value?.toString() ?? '{}';
    const body = this.serializer.deserialize(value);

    const headers: MessageHeaders = {};
    if (message.headers) {
      for (const [key, val] of Object.entries(message.headers)) {
        headers[key] = val?.toString();
      }
    }

    const offset = message.offset;
    const messageId = `${topic}-${partition}-${offset}`;

    return createMessage({
      id: messageId,
      body,
      key: message.key?.toString(),
      headers,
      timestamp: message.timestamp
        ? new Date(parseInt(message.timestamp, 10))
        : new Date(),
      deliveryAttempt: 1,
      metadata: {
        provider: 'kafka',
        kafka: {
          topic,
          partition,
          offset,
          highWatermark: (payload as unknown as { batch?: { highWatermark: string } }).batch?.highWatermark ?? offset,
          key: message.key?.toString(),
        },
      },
      raw: payload,
      onAck: async () => {
        // Manual commit if autoCommit is disabled
        if (this.consumer && !(this.groupConfig.autoCommit ?? true)) {
          await this.consumer.commitOffsets([
            {
              topic,
              partition,
              offset: (BigInt(offset) + 1n).toString(),
            },
          ]);
        }
        this.logger.debug('Message acknowledged', { messageId, topic, partition, offset });
      },
      onNack: async (requeue = true) => {
        // Kafka doesn't have native nack - we can seek back to reprocess
        if (requeue && this.consumer) {
          this.consumer.seek({ topic, partition, offset });
        }
        this.logger.debug('Message nacked', { messageId, topic, partition, offset, requeue });
      },
    });
  }
}
