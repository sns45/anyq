/**
 * @fileoverview Kafka producer implementation
 * @module @anyq/kafka/producer
 */

import { Kafka, type Producer, CompressionTypes, type ProducerRecord, type Message as KafkaMessage, type SASLOptions } from 'kafkajs';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { KafkaConfig, KafkaProducerOptions } from './config.js';

/**
 * Map compression type string to KafkaJS enum
 */
function getCompressionType(compression?: string): CompressionTypes {
  switch (compression) {
    case 'gzip':
      return CompressionTypes.GZIP;
    case 'snappy':
      return CompressionTypes.Snappy;
    case 'lz4':
      return CompressionTypes.LZ4;
    case 'zstd':
      return CompressionTypes.ZSTD;
    default:
      return CompressionTypes.None;
  }
}

/**
 * Kafka producer implementation
 *
 * Publishes messages to Kafka topics.
 *
 * @example
 * ```typescript
 * const producer = new KafkaProducer({
 *   driver: 'kafka',
 *   topic: 'orders',
 *   kafka: { brokers: ['localhost:9092'] },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' });
 * await producer.disconnect();
 * ```
 */
export class KafkaProducer<T = unknown> extends BaseProducer<T> {
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private readonly topic: string;
  private readonly producerOptions: KafkaProducerOptions;
  private readonly compression: CompressionTypes;

  constructor(config: KafkaConfig) {
    super(config);
    this.topic = config.topic;
    this.producerOptions = config.producer ?? {};
    this.compression = getCompressionType(config.producer?.compression);
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
        clientId: kafkaConfig.clientId ?? 'anyq-producer',
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

      this.producer = this.kafka.producer({
        idempotent: this.producerOptions.idempotent,
        maxInFlightRequests: this.producerOptions.maxInFlightRequests,
        transactionalId: this.producerOptions.transactionalId,
      });

      await this.producer.connect();
      this._connected = true;
      this.logger.info('Kafka producer connected', {
        topic: this.topic,
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
    if (!this._connected || !this.producer) {
      return;
    }

    try {
      await this.producer.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    this.producer = null;
    this.kafka = null;
    this._connected = false;
    this.logger.info('Kafka producer disconnected');
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.producer) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const serializedData = this.serializer.serialize(body);
      const value = Buffer.isBuffer(serializedData)
        ? serializedData
        : Buffer.from(serializedData);

      const message: KafkaMessage = {
        key: options?.key ? Buffer.from(options.key) : undefined,
        value,
        headers: options?.headers
          ? Object.fromEntries(
              Object.entries(options.headers).map(([k, v]) => [
                k,
                v ? String(v) : undefined,
              ])
            )
          : undefined,
      };

      const record: ProducerRecord = {
        topic: this.topic,
        messages: [message],
        acks: this.producerOptions.acks,
        timeout: this.producerOptions.timeout,
        compression: this.compression,
      };

      const result = await this.producer.send(record);
      const { partition, offset } = result[0];
      const messageId = `${this.topic}-${partition}-${offset}`;

      this.logger.debug('Message published', {
        messageId,
        topic: this.topic,
        partition,
        offset,
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
   * Publish multiple messages in a batch
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.producer) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const kafkaMessages: KafkaMessage[] = messages.map(({ body, options }) => {
        const serializedData = this.serializer.serialize(body);
        const value = Buffer.isBuffer(serializedData)
          ? serializedData
          : Buffer.from(serializedData);

        return {
          key: options?.key ? Buffer.from(options.key) : undefined,
          value,
          headers: options?.headers
            ? Object.fromEntries(
                Object.entries(options.headers).map(([k, v]) => [
                  k,
                  v ? String(v) : undefined,
                ])
              )
            : undefined,
        };
      });

      const record: ProducerRecord = {
        topic: this.topic,
        messages: kafkaMessages,
        acks: this.producerOptions.acks,
        timeout: this.producerOptions.timeout,
        compression: this.compression,
      };

      const result = await this.producer.send(record);
      const messageIds: string[] = [];

      for (const { partition, baseOffset } of result) {
        if (baseOffset !== undefined) {
          for (let i = 0; i < kafkaMessages.length; i++) {
            const offset = BigInt(baseOffset) + BigInt(i);
            messageIds.push(`${this.topic}-${partition}-${offset}`);
          }
        }
      }

      this.logger.debug('Batch published', {
        count: messageIds.length,
        topic: this.topic,
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
      if (!this.kafka || !this.producer || !this._connected) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      // Get cluster metadata as a health check
      const admin = this.kafka.admin();
      await admin.connect();
      const topics = await admin.listTopics();
      await admin.disconnect();

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          topic: this.topic,
          topicExists: topics.includes(this.topic),
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
   * Get the underlying producer (for testing)
   */
  getProducer(): Producer | null {
    return this.producer;
  }
}
