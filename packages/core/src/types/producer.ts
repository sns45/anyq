/**
 * @fileoverview Producer types for anyq
 * @module @anyq/core/types/producer
 */

import type { MessageHeaders } from './message.js';

/**
 * Options for publishing a message
 */
export interface PublishOptions {
  /** Message key for partitioning/routing */
  key?: string;

  /** Custom headers/attributes */
  headers?: MessageHeaders;

  /** Partition number (Kafka only) */
  partition?: number;

  /** Delay delivery in seconds (SQS, Azure, Google Pub/Sub) */
  delaySeconds?: number;

  /** Message group ID for FIFO ordering (SQS FIFO, Azure sessions) */
  groupId?: string;

  /** Deduplication ID (SQS FIFO) */
  deduplicationId?: string;

  /** Ordering key (Google Pub/Sub) */
  orderingKey?: string;

  /** Message priority 0-255 (RabbitMQ) */
  priority?: number;

  /** Message TTL in milliseconds */
  ttlMs?: number;

  /** Correlation ID for request-response patterns */
  correlationId?: string;

  /** Reply-to address for RPC patterns */
  replyTo?: string;
}

/**
 * Health check status
 */
export interface HealthStatus {
  /** Overall health status */
  healthy: boolean;

  /** Connection status */
  connected: boolean;

  /** Last successful operation latency in ms */
  latencyMs?: number;

  /** Additional details */
  details?: Record<string, unknown>;

  /** Error if unhealthy */
  error?: string;
}

/**
 * Producer interface for publishing messages
 *
 * @template T - Type of message body
 */
export interface IProducer<T = unknown> {
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
   * Publish a single message
   *
   * @param body - Message payload
   * @param options - Publishing options
   * @returns Message ID or sequence number
   * @throws {PublishError} If publish fails
   */
  publish(body: T, options?: PublishOptions): Promise<string>;

  /**
   * Publish multiple messages in a batch
   *
   * @param messages - Array of messages with their options
   * @returns Array of message IDs in same order
   * @throws {PublishError} If any publish fails
   */
  publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]>;

  /**
   * Flush any buffered messages
   *
   * For batching producers, ensures all pending messages are sent
   */
  flush(): Promise<void>;

  /**
   * Get producer health status
   */
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Transaction context for transactional producers
 */
export interface TransactionContext<T = unknown> {
  /**
   * Publish within transaction
   */
  publish(body: T, options?: PublishOptions): Promise<string>;

  /**
   * Publish batch within transaction
   */
  publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]>;

  /**
   * Send consumer offsets within transaction (Kafka)
   */
  sendOffsets?(offsets: {
    consumerGroupId: string;
    topics: Array<{
      topic: string;
      partitions: Array<{ partition: number; offset: string }>;
    }>;
  }): Promise<void>;
}

/**
 * Extended producer with transaction support (Kafka, RabbitMQ)
 */
export interface ITransactionalProducer<T = unknown> extends IProducer<T> {
  /**
   * Begin a transaction
   */
  beginTransaction(): Promise<void>;

  /**
   * Commit current transaction
   */
  commitTransaction(): Promise<void>;

  /**
   * Abort current transaction
   */
  abortTransaction(): Promise<void>;

  /**
   * Execute operations within a transaction
   *
   * @param handler - Function to execute, transaction auto-commits on success
   */
  transaction<R>(
    handler: (tx: TransactionContext<T>) => Promise<R>
  ): Promise<R>;
}
