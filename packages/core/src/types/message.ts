/**
 * @fileoverview Message types for anyq
 * @module @anyq/core/types/message
 */

import type { QueueDriver } from './config.js';

/**
 * Message headers/attributes
 */
export type MessageHeaders = Record<string, string | Buffer | undefined>;

/**
 * Kafka-specific metadata
 */
export interface KafkaMetadata {
  topic: string;
  partition: number;
  offset: string;
  highWatermark: string;
  key?: string;
}

/**
 * SQS-specific metadata
 */
export interface SQSMetadata {
  queueUrl: string;
  receiptHandle: string;
  approximateReceiveCount: number;
  sentTimestamp: Date;
  approximateFirstReceiveTimestamp: Date;
  messageGroupId?: string;
  sequenceNumber?: string;
}

/**
 * RabbitMQ-specific metadata
 */
export interface RabbitMQMetadata {
  exchange: string;
  routingKey: string;
  consumerTag: string;
  deliveryTag: number;
  redelivered: boolean;
}

/**
 * Google Pub/Sub-specific metadata
 */
export interface GooglePubSubMetadata {
  subscription: string;
  ackId: string;
  publishTime: Date;
  orderingKey?: string;
}

/**
 * Azure Service Bus-specific metadata
 */
export interface AzureServiceBusMetadata {
  sequenceNumber: bigint;
  enqueuedTime: Date;
  lockedUntil?: Date;
  sessionId?: string;
  partitionKey?: string;
}

/**
 * Redis Streams-specific metadata
 */
export interface RedisStreamsMetadata {
  stream: string;
  entryId: string;
  consumerGroup: string;
  consumer: string;
  idleTime?: number;
}

/**
 * NATS JetStream-specific metadata
 */
export interface NATSMetadata {
  stream: string;
  subject: string;
  sequence: number;
  redelivered: boolean;
  redeliveryCount: number;
}

/**
 * In-memory adapter metadata
 */
export interface MemoryMetadata {
  queueName: string;
}

/**
 * Provider-specific metadata
 */
export interface ProviderMetadata {
  /** Queue driver type */
  provider: QueueDriver;

  /** Kafka-specific metadata */
  kafka?: KafkaMetadata;

  /** SQS-specific metadata */
  sqs?: SQSMetadata;

  /** RabbitMQ-specific metadata */
  rabbitmq?: RabbitMQMetadata;

  /** Google Pub/Sub-specific metadata */
  googlePubsub?: GooglePubSubMetadata;

  /** Azure Service Bus-specific metadata */
  azureServicebus?: AzureServiceBusMetadata;

  /** Redis Streams-specific metadata */
  redisStreams?: RedisStreamsMetadata;

  /** NATS JetStream-specific metadata */
  nats?: NATSMetadata;

  /** In-memory adapter metadata */
  memory?: MemoryMetadata;
}

/**
 * Universal message interface
 *
 * @template T - Type of the message body
 */
export interface IMessage<T = unknown> {
  /** Unique message identifier */
  readonly id: string;

  /** Deserialized message body */
  readonly body: T;

  /** Message key (for partitioning in Kafka, routing in RabbitMQ) */
  readonly key?: string;

  /** Message headers/attributes */
  readonly headers: MessageHeaders;

  /** Message timestamp (when produced) */
  readonly timestamp: Date;

  /** Delivery attempt count (starts at 1) */
  readonly deliveryAttempt: number;

  /** Provider-specific metadata */
  readonly metadata: ProviderMetadata;

  /**
   * Acknowledge successful processing
   *
   * - Kafka: Commits offset
   * - SQS: Deletes message
   * - RabbitMQ: Sends ACK
   * - Google Pub/Sub: Acknowledges message
   * - Redis Streams: XACK
   * - NATS: Ack
   */
  ack(): Promise<void>;

  /**
   * Negative acknowledgement / reject
   *
   * @param requeue - Whether to requeue the message (if supported)
   *
   * - Kafka: Does not commit offset, may seek back
   * - SQS: Returns to queue via visibility timeout
   * - RabbitMQ: Rejects with optional requeue
   * - Google Pub/Sub: Nack for redelivery
   * - Redis Streams: Does not XACK
   * - NATS: Nak or Term
   */
  nack(requeue?: boolean): Promise<void>;

  /**
   * Extend processing deadline (if supported)
   *
   * @param seconds - Additional seconds to extend
   *
   * - SQS: Extends visibility timeout
   * - Google Pub/Sub: Extends ack deadline
   * - Azure Service Bus: Renews lock
   * - NATS: InProgress signal
   */
  extendDeadline?(seconds: number): Promise<void>;

  /**
   * Access to raw provider message (escape hatch)
   */
  readonly raw: unknown;
}

/**
 * Parameters for creating a message wrapper
 */
export interface MessageCreateParams<T = unknown> {
  id: string;
  body: T;
  key?: string;
  headers: MessageHeaders;
  timestamp: Date;
  deliveryAttempt: number;
  metadata: ProviderMetadata;
  raw: unknown;
  onAck: () => Promise<void>;
  onNack: (requeue?: boolean) => Promise<void>;
  onExtendDeadline?: (seconds: number) => Promise<void>;
}

/**
 * Message factory interface
 */
export interface MessageFactory<T = unknown> {
  create(params: MessageCreateParams<T>): IMessage<T>;
}
