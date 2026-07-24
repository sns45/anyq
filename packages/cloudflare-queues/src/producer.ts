/**
 * @fileoverview Cloudflare Queues producer implementation
 * @module @anyq/cloudflare-queues/producer
 */

import type { MessageSendRequest, Queue } from '@cloudflare/workers-types';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { CloudflareQueuesConfig } from './config.js';

/**
 * Cloudflare Queues producer implementation
 *
 * Publishes messages to a Cloudflare Queue via the `Queue` binding injected
 * onto `env` by the Workers runtime. Unlike broker-polling adapters, there is
 * no connection to open; `connect()` simply validates that a binding was
 * supplied.
 *
 * @example
 * ```typescript
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const producer = new CloudflareQueuesProducer({
 *       driver: 'cloudflare-queues',
 *       queue: env.MY_QUEUE,
 *     });
 *
 *     await producer.connect();
 *     await producer.publish({ orderId: '123' });
 *     await producer.disconnect();
 *
 *     return new Response('ok');
 *   },
 * };
 * ```
 */
export class CloudflareQueuesProducer<T = unknown> extends BaseProducer<T> {
  private queue: Queue<T> | null = null;
  private readonly queueName?: string;

  constructor(config: CloudflareQueuesConfig) {
    super(config);
    this.queueName = config.queueName;
  }

  /**
   * Validate the injected `Queue` binding
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const cfg = this.config as CloudflareQueuesConfig;
    if (!cfg.queue) {
      throw new ConnectionError(
        'Cloudflare Queues producer requires a `queue` binding in config ' +
          "(e.g. { queue: env.MY_QUEUE }); Cloudflare Queues has no dial-in " +
          'connection, so this is the injected Worker binding.'
      );
    }

    this.queue = cfg.queue as Queue<T>;
    this._connected = true;
    this.logger.info('Cloudflare Queues producer connected', {
      queueName: this.queueName,
    });
  }

  /**
   * Release the binding reference
   */
  async disconnect(): Promise<void> {
    if (!this._connected) {
      return;
    }

    this.queue = null;
    this._connected = false;
    this.logger.info('Cloudflare Queues producer disconnected');
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.queue) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const messageId = this.generateMessageId();

      await this.queue.send(body, {
        contentType: 'json',
        delaySeconds: options?.delaySeconds,
      });

      this.logger.debug('Message published', {
        messageId,
        queueName: this.queueName,
      });

      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message to Cloudflare Queue', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages in a batch
   *
   * Cloudflare's `sendBatch` caps a single request at 100 messages; larger
   * arrays are chunked automatically.
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.queue) {
      throw new ConnectionError('Producer not connected');
    }

    const CF_BATCH_LIMIT = 100;
    const chunks: Array<Array<{ body: T; options?: PublishOptions }>> = [];
    for (let i = 0; i < messages.length; i += CF_BATCH_LIMIT) {
      chunks.push(messages.slice(i, i + CF_BATCH_LIMIT));
    }

    const messageIds: string[] = [];

    try {
      for (const chunk of chunks) {
        const entries: MessageSendRequest<T>[] = chunk.map(({ body, options }) => ({
          body,
          contentType: 'json',
          delaySeconds: options?.delaySeconds,
        }));

        await this.queue.sendBatch(entries);

        for (let i = 0; i < chunk.length; i++) {
          messageIds.push(this.generateMessageId());
        }
      }

      this.logger.debug('Batch published', {
        count: messageIds.length,
        queueName: this.queueName,
      });

      return messageIds;
    } catch (error) {
      throw new PublishError('Failed to publish batch to Cloudflare Queue', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    if (!this.queue || !this._connected) {
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
        queueName: this.queueName,
      },
    };
  }

  /**
   * Generate a locally-unique message id.
   *
   * Cloudflare Queues' `send`/`sendBatch` do not return a broker-assigned
   * message id (unlike SQS), so one is generated client-side purely for
   * caller-facing bookkeeping/logging.
   */
  private generateMessageId(): string {
    return `cfq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Get the underlying Queue binding (for testing)
   */
  getQueue(): Queue<T> | null {
    return this.queue;
  }
}
