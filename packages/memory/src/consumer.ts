/**
 * @fileoverview Memory consumer implementation
 * @module @anyq/memory/consumer
 */

import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  type IMessage,
  ConnectionError,
} from '@anyq/core';
import type { MemoryQueueConfig } from './config.js';
import { MemoryQueue, type StoredMessage } from './queue.js';
import { getQueue, registerQueue } from './registry.js';

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
 * In-memory consumer implementation
 *
 * Consumes messages from an in-memory queue for testing.
 *
 * @example
 * ```typescript
 * const consumer = new MemoryConsumer({
 *   driver: 'memory',
 *   queueName: 'test-queue',
 * });
 *
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 * ```
 */
export class MemoryConsumer<T = unknown> extends BaseConsumer<T> {
  private queue: MemoryQueue<T> | null = null;
  private dlq: MemoryQueue<unknown> | null = null;
  private readonly queueName: string;
  private readonly maxDeliveryAttempts: number;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: MemoryQueueConfig) {
    super(config);
    this.queueName = config.queueName ?? 'default';
    this.maxDeliveryAttempts = config.deadLetterQueue?.maxDeliveryAttempts ?? 3;

    // Setup DLQ if configured
    if (config.deadLetterQueue?.enabled) {
      const dlqName = config.deadLetterQueue.destination ?? `${this.queueName}-dlq`;
      let dlq = getQueue<unknown>(dlqName);
      if (!dlq) {
        dlq = new MemoryQueue<unknown>(dlqName);
        registerQueue(dlqName, dlq);
      }
      this.dlq = dlq;
    }
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
      this.logger.info('Memory consumer connected', { queue: this.queueName });
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

    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.queue = null;
    this._connected = false;
    this.logger.info('Memory consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.queue) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    // Poll for messages
    const poll = async () => {
      if (!this.running || this._paused || !this.queue) {
        return;
      }

      const stored = this.queue.dequeue();
      if (!stored) {
        return;
      }

      const message = this.createWrappedMessage(stored);

      try {
        this.emit('message', message);
        await handler(message);

        if (opts.autoAck) {
          await message.ack();
        }
      } catch (error) {
        this.logger.error('Error processing message', {
          messageId: stored.id,
          error: error instanceof Error ? error.message : String(error),
        });

        this.emit('error', error instanceof Error ? error : new Error(String(error)));

        // Check if we should send to DLQ
        if (stored.deliveryAttempt >= this.maxDeliveryAttempts && this.dlq) {
          this.queue.deadLetter(
            stored.id,
            this.dlq,
            error instanceof Error ? error : new Error(String(error))
          );
          this.logger.warn('Message sent to DLQ', {
            messageId: stored.id,
            attempts: stored.deliveryAttempt,
          });
        } else {
          // Requeue for retry
          await message.nack(true);
        }
      }
    };

    // Start polling
    this.pollInterval = setInterval(poll, 10);
    this.logger.info('Subscribed to queue', { queue: this.queueName });
  }

  /**
   * Subscribe to message batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.queue) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    const poll = async () => {
      if (!this.running || this._paused || !this.queue) {
        return;
      }

      const storedMessages = this.queue.dequeueBatch(opts.batchSize);
      if (storedMessages.length === 0) {
        return;
      }

      const messages = storedMessages.map((stored) =>
        this.createWrappedMessage(stored)
      );

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

        this.emit('error', error instanceof Error ? error : new Error(String(error)));

        // Nack all messages in batch
        for (const message of messages) {
          await message.nack(true);
        }
      }
    };

    this.pollInterval = setInterval(poll, opts.batchTimeout);
    this.logger.info('Subscribed to queue (batch)', { queue: this.queueName });
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
    return {
      healthy: this._connected,
      connected: this._connected,
      details: {
        queue: this.queueName,
        queueSize: this.queue?.size() ?? 0,
        processing: this.queue?.processingCount() ?? 0,
        paused: this._paused,
      },
    };
  }

  /**
   * Get the underlying queue (for testing)
   */
  getQueue(): MemoryQueue<T> | null {
    return this.queue;
  }

  /**
   * Get the DLQ (for testing)
   */
  getDLQ(): MemoryQueue<unknown> | null {
    return this.dlq;
  }

  /**
   * Create a wrapped message from stored message
   */
  private createWrappedMessage(stored: StoredMessage<T>): IMessage<T> {
    return createMessage({
      id: stored.id,
      body: stored.body,
      key: stored.key,
      headers: stored.headers,
      timestamp: stored.timestamp,
      deliveryAttempt: stored.deliveryAttempt,
      metadata: {
        provider: 'memory',
        memory: { queueName: this.queueName },
      },
      raw: stored,
      onAck: async () => {
        this.queue?.ack(stored.id);
        this.logger.debug('Message acknowledged', { messageId: stored.id });
      },
      onNack: async (requeue = true) => {
        this.queue?.nack(stored.id, requeue);
        this.logger.debug('Message nacked', { messageId: stored.id, requeue });
      },
    });
  }
}
