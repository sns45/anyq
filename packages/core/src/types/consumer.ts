/**
 * @fileoverview Consumer types for anyq
 * @module @anyq/core/types/consumer
 */

import type { IMessage } from './message.js';
import type { HealthStatus } from './producer.js';

/**
 * Message handler function
 */
export type MessageHandler<T = unknown> = (
  message: IMessage<T>
) => Promise<void>;

/**
 * Batch message handler function
 */
export type BatchMessageHandler<T = unknown> = (
  messages: IMessage<T>[]
) => Promise<void>;

/**
 * Options for subscribing to messages
 */
export interface SubscribeOptions {
  /** Start consuming from the beginning (Kafka, NATS) */
  fromBeginning?: boolean;

  /** Start from specific timestamp (Kafka, Google Pub/Sub, NATS) */
  fromTimestamp?: Date;

  /** Maximum concurrent message processing. Default: 1 */
  concurrency?: number;

  /** Auto-acknowledge after handler completes without error. Default: true */
  autoAck?: boolean;

  /** Maximum messages per batch (for batch handlers). Default: 10 */
  batchSize?: number;

  /** Maximum time to wait for batch to fill in ms. Default: 1000 */
  batchTimeout?: number;
}

/**
 * Seek position for repositioning consumer
 */
export interface SeekPosition {
  /** Seek to beginning of queue/topic */
  beginning?: boolean;

  /** Seek to end (only new messages) */
  end?: boolean;

  /** Seek to specific timestamp */
  timestamp?: Date;

  /** Seek to specific offset (Kafka) */
  offset?: string;

  /** Partition to seek (Kafka) */
  partition?: number;
}

/**
 * Partition lag details
 */
export interface PartitionLag {
  partition: number;
  currentOffset: string;
  highWatermark: string;
  lag: number;
}

/**
 * Consumer lag metrics
 */
export interface ConsumerLag {
  /** Total lag across all partitions/streams */
  totalLag: number;

  /** Per-partition lag details (Kafka) */
  partitions?: PartitionLag[];
}

/**
 * Consumer events
 */
export interface ConsumerEvents<T = unknown> {
  /** Emitted on errors */
  error: (error: Error) => void;

  /** Emitted when backpressure is triggered */
  backpressure: (info: { active: number; highWaterMark: number }) => void;

  /** Emitted during rebalance (Kafka) */
  rebalancing: (info: { partitions: number[] }) => void;

  /** Emitted after rebalance completes (Kafka) */
  rebalanced: (info: { partitions: number[] }) => void;

  /** Emitted when consumer crashes */
  crash: (error: Error) => void;

  /** Emitted when message is received (before processing) */
  message: (message: IMessage<T>) => void;
}

/**
 * Event emitter interface for consumers
 */
export interface IConsumerEventEmitter<T = unknown> {
  on<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this;

  off<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this;

  emit<K extends keyof ConsumerEvents<T>>(
    event: K,
    ...args: Parameters<ConsumerEvents<T>[K]>
  ): boolean;
}

/**
 * Consumer interface for receiving messages
 *
 * @template T - Type of message body
 */
export interface IConsumer<T = unknown> extends IConsumerEventEmitter<T> {
  /**
   * Connect to the message broker
   *
   * @throws {ConnectionError} If connection fails after retries
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the message broker
   */
  disconnect(): Promise<void>;

  /**
   * Check if currently connected
   */
  isConnected(): boolean;

  /**
   * Subscribe to messages with individual handler
   *
   * @param handler - Function to process each message
   * @param options - Subscription options
   */
  subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void>;

  /**
   * Subscribe to messages with batch handler
   *
   * @param handler - Function to process message batches
   * @param options - Subscription options
   */
  subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void>;

  /**
   * Pause message consumption
   */
  pause(): Promise<void>;

  /**
   * Resume message consumption
   */
  resume(): Promise<void>;

  /**
   * Check if consumption is paused
   */
  isPaused(): boolean;

  /**
   * Seek to specific position (Kafka, NATS)
   *
   * @param position - Position to seek to
   */
  seek?(position: SeekPosition): Promise<void>;

  /**
   * Get consumer lag metrics (Kafka)
   */
  getLag?(): Promise<ConsumerLag>;

  /**
   * Get consumer health status
   */
  healthCheck(): Promise<HealthStatus>;
}
