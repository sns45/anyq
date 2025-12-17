/**
 * @fileoverview Memory producer implementation
 * @module @anyq/memory/producer
 */

import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
} from '@anyq/core';
import type { MemoryQueueConfig } from './config.js';
import { MemoryQueue } from './queue.js';
import { getQueue, registerQueue } from './registry.js';

/**
 * In-memory producer implementation
 *
 * Publishes messages to an in-memory queue for testing.
 *
 * @example
 * ```typescript
 * const producer = new MemoryProducer({
 *   driver: 'memory',
 *   queueName: 'test-queue',
 * });
 *
 * await producer.connect();
 * await producer.publish({ data: 'test' });
 * await producer.disconnect();
 * ```
 */
export class MemoryProducer<T = unknown> extends BaseProducer<T> {
  private queue: MemoryQueue<T> | null = null;
  private readonly queueName: string;

  constructor(config: MemoryQueueConfig) {
    super(config);
    this.queueName = config.queueName ?? 'default';
  }

  /**
   * Connect to the in-memory queue
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      // Get or create the queue
      let queue = getQueue<T>(this.queueName);
      if (!queue) {
        const config = this.config as MemoryQueueConfig;
        queue = new MemoryQueue<T>(this.queueName, {
          maxMessages: config.maxMessages,
          maxAgeMs: config.maxAgeMs,
        });
        registerQueue(this.queueName, queue);
      }

      this.queue = queue;
      this._connected = true;
      this.logger.info('Memory producer connected', { queue: this.queueName });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to memory queue',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from the queue
   */
  async disconnect(): Promise<void> {
    if (!this._connected) {
      return;
    }

    this.queue = null;
    this._connected = false;
    this.logger.info('Memory producer disconnected');
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.queue) {
      throw new ConnectionError('Producer not connected');
    }

    const messageId = this.queue.enqueue(body, {
      key: options?.key,
      headers: options?.headers,
    });

    this.logger.debug('Message published', {
      messageId,
      queue: this.queueName,
      key: options?.key,
    });

    return messageId;
  }

  /**
   * Publish multiple messages
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.queue) {
      throw new ConnectionError('Producer not connected');
    }

    const messageIds: string[] = [];

    for (const { body, options } of messages) {
      const id = this.queue.enqueue(body, {
        key: options?.key,
        headers: options?.headers,
      });
      messageIds.push(id);
    }

    this.logger.debug('Batch published', {
      count: messageIds.length,
      queue: this.queueName,
    });

    return messageIds;
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this._connected,
      connected: this._connected,
      details: {
        queue: this.queueName,
        queueSize: this.queue?.size() ?? 0,
      },
    };
  }

  /**
   * Get the underlying queue (for testing)
   */
  getQueue(): MemoryQueue<T> | null {
    return this.queue;
  }
}
