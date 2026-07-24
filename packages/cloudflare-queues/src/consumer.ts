/**
 * @fileoverview Cloudflare Queues consumer implementation
 * @module @anyq/cloudflare-queues/consumer
 */

import type { Message as CFMessage, MessageBatch } from '@cloudflare/workers-types';
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
import type { CloudflareQueuesConfig } from './config.js';

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
 * Cloudflare Queues consumer implementation
 *
 * Cloudflare Queues is push-based: the platform delivers batches directly to
 * a Worker's `queue(batch, env, ctx)` export — there is no long-poll pull
 * loop for a consumer to run. `subscribe`/`subscribeBatch` therefore just
 * register a handler; the caller's Worker must forward each delivered batch
 * to {@link processBatch}, which wraps it into anyq `IMessage`s and invokes
 * the registered handler.
 *
 * @example
 * ```typescript
 * const consumer = new CloudflareQueuesConsumer({ driver: 'cloudflare-queues' });
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 *
 * export default {
 *   async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
 *     await consumer.processBatch(batch);
 *   },
 * };
 * ```
 */
export class CloudflareQueuesConsumer<T = unknown> extends BaseConsumer<T> {
  private readonly queueName?: string;
  private handler: MessageHandler<T> | null = null;
  private batchHandler: BatchMessageHandler<T> | null = null;
  private subscribeOptions: Required<SubscribeOptions> = DEFAULT_SUBSCRIBE_OPTIONS;

  // Cloudflare Queues supports scheduled redelivery natively via
  // `Message#retry({ delaySeconds })`.
  protected get supportsNativeDelay(): boolean {
    return true;
  }

  constructor(config: CloudflareQueuesConfig) {
    super(config);
    this.queueName = config.queueName;
  }

  /**
   * Native park: re-schedule the in-flight message via `retry({ delaySeconds })`.
   */
  protected override async parkMessage(
    message: IMessage<T>,
    delayMs: number
  ): Promise<void> {
    const cfMessage = message.raw as CFMessage<T> | undefined;
    if (!cfMessage) {
      this.logger.warn('parkMessage called without a raw Cloudflare message', {
        messageId: message.id,
      });
      await message.nack(false);
      return;
    }

    const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
    cfMessage.retry({ delaySeconds });
    this.logger.debug('Message parked for redelivery', {
      messageId: message.id,
      delaySeconds,
    });
  }

  /**
   * Cloudflare Queues has no dial-in connection for a consumer; this just
   * marks the consumer ready to accept batches via {@link processBatch}.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    this._connected = true;
    this.logger.info('Cloudflare Queues consumer connected', {
      queueName: this.queueName,
    });

    this.verifyParkPolicy();
  }

  /**
   * Disconnect and drop the registered handler(s)
   */
  async disconnect(): Promise<void> {
    this.beginShutdown();
    this.handler = null;
    this.batchHandler = null;
    this._connected = false;
    this.logger.info('Cloudflare Queues consumer disconnected');
  }

  /**
   * Register a per-message handler. Does not start any polling loop — call
   * {@link processBatch} from your Worker's `queue()` export to feed it
   * batches delivered by the platform.
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this._connected) {
      throw new ConnectionError('Consumer not connected');
    }

    this.handler = handler;
    this.batchHandler = null;
    this.subscribeOptions = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };

    this.logger.info('Subscribed (push-based; forward batches to processBatch)', {
      queueName: this.queueName,
    });
  }

  /**
   * Register a batch handler. Does not start any polling loop — call
   * {@link processBatch} from your Worker's `queue()` export to feed it
   * batches delivered by the platform.
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this._connected) {
      throw new ConnectionError('Consumer not connected');
    }

    this.batchHandler = handler;
    this.handler = null;
    this.subscribeOptions = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };

    this.logger.info(
      'Subscribed to batches (push-based; forward batches to processBatch)',
      { queueName: this.queueName }
    );
  }

  /**
   * Process a `MessageBatch` delivered by the Workers runtime to the
   * Worker's `queue(batch, env, ctx)` export.
   *
   * Wraps each Cloudflare `Message` into an anyq `IMessage`, mapping
   * `ack()`/`nack(requeue)` onto the platform's `Message#ack()` /
   * `Message#retry()`, and invokes whichever handler was registered via
   * {@link subscribe} or {@link subscribeBatch}.
   */
  async processBatch(batch: MessageBatch<T>): Promise<void> {
    if (this._paused) {
      batch.retryAll();
      this.logger.debug('Consumer paused; retrying whole batch', {
        count: batch.messages.length,
      });
      return;
    }

    const wrapped = batch.messages.map((cfMessage) =>
      this.createWrappedMessage(cfMessage, batch.queue)
    );

    if (this.batchHandler) {
      await this.processAsBatch(this.batchHandler, wrapped);
      return;
    }

    if (this.handler) {
      await this.processIndividually(this.handler, wrapped);
      return;
    }

    this.logger.warn(
      'processBatch called with no handler registered; retrying whole batch',
      { count: batch.messages.length }
    );
    batch.retryAll();
  }

  private async processIndividually(
    handler: MessageHandler<T>,
    messages: IMessage<T>[]
  ): Promise<void> {
    for (const message of messages) {
      try {
        this.emit('message', message);
        await handler(message);

        if (this.subscribeOptions.autoAck) {
          await message.ack();
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const result = await this.applyStrategy(message, err, () => handler(message));
        if (!result.handled) {
          this.logger.error('Error processing message', {
            messageId: message.id,
            error: err.message,
          });
          this.emit('error', err);
        }
      }
    }
  }

  private async processAsBatch(
    handler: BatchMessageHandler<T>,
    messages: IMessage<T>[]
  ): Promise<void> {
    try {
      await handler(messages);

      if (this.subscribeOptions.autoAck) {
        for (const message of messages) {
          await message.ack();
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Cloudflare Queues supports per-message ack/retry, so apply the
      // strategy per message rather than failing the whole batch.
      let anyUnhandled = false;
      for (const message of messages) {
        const result = await this.applyStrategy(message, err, () =>
          handler([message])
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
  }

  /**
   * Pause consumption. Incoming batches are retried in full via
   * `retryAll()` until {@link resume} is called.
   */
  async pause(): Promise<void> {
    await super.pause();
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    await super.resume();
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this._connected,
      connected: this._connected,
      details: {
        queueName: this.queueName,
        paused: this._paused,
        hasHandler: Boolean(this.handler || this.batchHandler),
      },
    };
  }

  /**
   * Create a wrapped message from a Cloudflare `Message`
   */
  private createWrappedMessage(
    cfMessage: CFMessage<T>,
    queueName: string
  ): IMessage<T> {
    const headers: MessageHeaders = {};

    return createMessage({
      id: cfMessage.id,
      body: cfMessage.body,
      headers,
      timestamp: cfMessage.timestamp,
      deliveryAttempt: cfMessage.attempts,
      metadata: {
        provider: 'cloudflare-queues',
        cloudflareQueues: {
          queueName,
          attempts: cfMessage.attempts,
        },
      },
      raw: cfMessage,
      onAck: async () => {
        cfMessage.ack();
        this.logger.debug('Message acknowledged', { messageId: cfMessage.id });
      },
      onNack: async (requeue = true) => {
        if (requeue) {
          cfMessage.retry();
        } else {
          // No requeue: ack it so it's removed rather than redelivered.
          cfMessage.ack();
        }
        this.logger.debug('Message nacked', {
          messageId: cfMessage.id,
          requeue,
        });
      },
    });
  }
}
