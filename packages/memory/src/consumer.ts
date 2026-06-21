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
  private parkTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // Memory adapter supports scheduled delivery natively via setTimeout
  // re-enqueue (see parkMessage below).
  protected get supportsNativeDelay(): boolean {
    return true;
  }

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

    // No-op for memory (native delay), but kept uniform across adapters.
    this.verifyParkPolicy();
  }

  /**
   * Disconnect from the queue
   */
  async disconnect(): Promise<void> {
    this.beginShutdown();
    if (!this._connected) {
      return;
    }

    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const timer of this.parkTimers) {
      clearTimeout(timer);
    }
    this.parkTimers.clear();

    this.queue = null;
    this._connected = false;
    this.logger.info('Memory consumer disconnected');
  }

  /**
   * Native dead-letter for memory: route via the existing MemoryQueue.deadLetter()
   * path so DLQ headers (x-original-queue, x-death-reason, ...) are preserved.
   */
  protected override async deadLetterMessage(
    message: IMessage<T>,
    reason: string,
  ): Promise<void> {
    const stored = message.raw as StoredMessage<T> | undefined;
    if (this.queue && this.dlq && stored) {
      this.queue.deadLetter(stored.id, this.dlq, new Error(reason));
      this.logger.warn('Message dead-lettered', {
        messageId: message.id,
        reason,
      });
      return;
    }
    // No DLQ configured: drop without requeue.
    this.logger.warn('No DLQ configured; dropping message', {
      messageId: message.id,
      reason,
    });
    await message.nack(false);
  }

  /**
   * Native park for memory: re-enqueue after `delayMs` via setTimeout.
   * The message body is re-published to the same queue so it gets a fresh
   * delivery attempt counter for the next pickup.
   */
  protected override async parkMessage(
    message: IMessage<T>,
    delayMs: number,
  ): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      this.logger.warn('parkMessage called without a connected queue', {
        messageId: message.id,
      });
      await message.nack(false);
      return;
    }

    // Remove the message from the processing map so it doesn't sit there.
    const stored = message.raw as StoredMessage<T> | undefined;
    if (stored) {
      queue.ack(stored.id);
    }

    const body = message.body;
    const key = message.key;
    const headers = { ...message.headers };

    const timer = setTimeout(() => {
      this.parkTimers.delete(timer);
      try {
        queue.enqueue(body, { key, headers });
      } catch (err) {
        this.logger.error('Failed to re-enqueue parked message', {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, delayMs);

    this.parkTimers.add(timer);
    this.logger.debug('Message parked for redelivery', {
      messageId: message.id,
      delayMs,
    });
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
        const err = error instanceof Error ? error : new Error(String(error));
        const result = await this.applyStrategy(message, err, () =>
          handler(message),
        );
        if (!result.handled) {
          this.logger.error('Error processing message', {
            messageId: stored.id,
            error: err.message,
          });

          this.emit('error', err);

          // Legacy behaviour: DLQ after maxDeliveryAttempts; otherwise requeue.
          if (stored.deliveryAttempt >= this.maxDeliveryAttempts && this.dlq) {
            this.queue.deadLetter(stored.id, this.dlq, err);
            this.logger.warn('Message sent to DLQ', {
              messageId: stored.id,
              attempts: stored.deliveryAttempt,
            });
          } else {
            await message.nack(true);
          }
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
        const err = error instanceof Error ? error : new Error(String(error));
        // Memory supports per-message ack, so apply the strategy per message.
        let anyUnhandled = false;
        for (const message of messages) {
          const result = await this.applyStrategy(message, err, () =>
            handler([message]),
          );
          if (!result.handled) {
            anyUnhandled = true;
          }
        }
        if (anyUnhandled) {
          this.logger.error('Error processing batch', {
            count: messages.length,
            error: err.message,
          });
          this.emit('error', err);
          for (const message of messages) {
            await message.nack(true);
          }
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
