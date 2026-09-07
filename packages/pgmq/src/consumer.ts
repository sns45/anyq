/**
 * @fileoverview pgmq consumer implementation
 * @module @anyq/pgmq/consumer
 */

import type { Pool } from 'pg';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  type IMessage,
  ConfigurationError,
  ConnectionError,
} from '@anyq/core';
import type { PgmqConfig, PgmqConsumerOptions } from './config.js';
import {
  asConnectionError,
  createPool,
  ensurePgmq,
  ensureQueue,
  hasReadWithPoll,
  packHeaders,
  toJsonText,
  unpackHeaders,
  validateQueueName,
  type PgmqRow,
} from './client.js';

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
 * pgmq consumer implementation
 *
 * Reads with `pgmq.read` (or `pgmq.read_with_poll` when available) using the
 * visibility timeout as the processing lease, exactly like SQS. A message
 * that is neither acked nor nacked reappears once its `vt` lapses, with
 * `read_ct` incremented, so `deliveryAttempt` is always truthful.
 *
 * Native hooks:
 * - `park`: `pgmq.set_vt(queue, id, delay)`, no in-process downgrade
 * - dead letter: `pgmq.send` to the DLQ queue, then delete the original
 * - `nack(false)`: `pgmq.archive`, so nothing is silently dropped
 *
 * @example
 * ```typescript
 * const consumer = new PgmqConsumer({
 *   driver: 'pgmq',
 *   queueName: 'orders',
 *   pg: { connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' },
 *   consumer: { visibilityTimeout: 30 },
 * });
 *
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 * ```
 */
export class PgmqConsumer<T = unknown> extends BaseConsumer<T> {
  private pool: Pool | null = null;
  private ownsPool = false;
  private readonly queueName: string;
  private readonly dlqName: string | null;
  private readonly consumerOptions: Required<PgmqConsumerOptions>;
  private running = false;
  private pollingPromise: Promise<void> | null = null;
  private useLongPoll = false;

  // pgmq schedules redelivery natively through the visibility timeout, so
  // `park` never downgrades to an in-process sleep.
  protected get supportsNativeDelay(): boolean {
    return true;
  }

  constructor(config: PgmqConfig) {
    super(config);
    this.queueName = validateQueueName(config.queueName);

    const dlq = config.deadLetterQueue;
    this.dlqName = dlq?.enabled
      ? validateQueueName(dlq.destination || `${this.queueName}_dlq`, 'deadLetterQueue.destination')
      : null;

    const c = config.consumer ?? {};
    this.consumerOptions = {
      visibilityTimeout: c.visibilityTimeout ?? 30,
      pollingInterval: c.pollingInterval ?? 1000,
      longPollSeconds: c.longPollSeconds ?? 5,
      longPollIntervalMs: c.longPollIntervalMs ?? 100,
      maxMessages: c.maxMessages ?? 100,
    };
  }

  /**
   * Open the pool, verify pgmq, create the queue and DLQ when allowed, and
   * detect long poll support.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const config = this.config as PgmqConfig;
    const { pool, owned } = createPool(config);
    pool.on('error', (err) => {
      this.logger.error('pg pool error', { error: err.message });
    });

    try {
      await ensurePgmq(pool, config.autoInstall ?? true);
      if (config.autoCreate !== false) {
        await ensureQueue(pool, this.queueName);
        if (this.dlqName) {
          await ensureQueue(pool, this.dlqName);
        }
      }
      this.useLongPoll =
        this.consumerOptions.longPollSeconds > 0 && (await hasReadWithPoll(pool));
      if (this.consumerOptions.longPollSeconds > 0 && !this.useLongPoll) {
        this.logger.debug(
          'pgmq.read_with_poll not available; using pgmq.read with pollingInterval',
        );
      }
    } catch (error) {
      if (owned) {
        await pool.end().catch(() => undefined);
      }
      if (error instanceof ConnectionError || error instanceof ConfigurationError) {
        throw error;
      }
      throw asConnectionError('Failed to connect to Postgres', error);
    }

    this.pool = pool;
    this.ownsPool = owned;
    this._connected = true;
    this.logger.info('pgmq consumer connected', {
      queue: this.queueName,
      dlq: this.dlqName ?? undefined,
      visibilityTimeout: this.consumerOptions.visibilityTimeout,
      longPoll: this.useLongPoll,
    });

    // Native delay, so this only re-arms the shutdown flag; kept uniform
    // across adapters.
    this.verifyParkPolicy();
  }

  /**
   * Stop polling and end the pool (only if this adapter created it).
   */
  async disconnect(): Promise<void> {
    this.beginShutdown();
    if (!this._connected || !this.pool) {
      return;
    }

    this.running = false;
    if (this.pollingPromise) {
      await this.pollingPromise;
      this.pollingPromise = null;
    }

    const pool = this.pool;
    this.pool = null;
    this._connected = false;
    if (this.ownsPool) {
      await pool.end().catch(() => undefined);
    }
    this.logger.info('pgmq consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<void> {
    if (!this.pool) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;
    this.pollingPromise = this.poll(handler, opts);

    this.logger.info('Subscribed to queue', { queue: this.queueName });
  }

  /**
   * Subscribe to message batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<void> {
    if (!this.pool) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;
    this.pollingPromise = this.pollBatch(handler, opts);

    this.logger.info('Subscribed to queue (batch)', { queue: this.queueName });
  }

  /**
   * Native park: push the visibility timeout out by `delayMs`. The message
   * comes back with `read_ct` incremented, so the next attempt is counted.
   */
  protected override async parkMessage(
    message: IMessage<T>,
    delayMs: number,
  ): Promise<void> {
    const seconds = Math.max(0, Math.ceil(delayMs / 1000));
    try {
      await this.setVt(message.id, seconds);
      this.logger.debug('Message parked for redelivery', {
        messageId: message.id,
        delaySeconds: seconds,
      });
    } catch (err) {
      this.logger.error('Failed to park message; returning it to the queue', {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await message.nack(true);
    }
  }

  /**
   * Native dead letter: copy to the DLQ queue with the same headers the
   * memory adapter attaches, then delete the original. Without a DLQ the
   * message is archived rather than dropped.
   */
  protected override async deadLetterMessage(
    message: IMessage<T>,
    reason: string,
  ): Promise<void> {
    const pool = this.pool;
    if (this.dlqName && pool) {
      const dlqConfig = this.config.deadLetterQueue;
      const headers: Record<string, string | Buffer | undefined> = {
        ...message.headers,
        'x-original-queue': this.queueName,
        'x-death-time': new Date().toISOString(),
        'x-delivery-attempts': String(message.deliveryAttempt),
      };
      if (dlqConfig?.includeError !== false) {
        headers['x-death-reason'] = reason;
      }

      try {
        await pool.query('SELECT pgmq.send($1, $2::jsonb, $3::jsonb)', [
          this.dlqName,
          toJsonText(this.serializer.serialize(message.body)),
          JSON.stringify(packHeaders(headers, message.key)),
        ]);
        await this.deleteOne(message.id);
        this.logger.warn('Message dead-lettered', {
          messageId: message.id,
          reason,
          dlq: this.dlqName,
        });
        return;
      } catch (err) {
        this.logger.error('Failed to dead-letter message; archiving instead', {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.logger.warn('No DLQ configured; archiving message', {
        messageId: message.id,
        reason,
      });
    }
    await message.nack(false);
  }

  /**
   * Round trip to Postgres plus queue depth from `pgmq.metrics`.
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    if (!this.pool || !this._connected) {
      return { healthy: false, connected: false, error: 'Not connected' };
    }
    try {
      await this.pool.query('SELECT 1');
      const details: Record<string, unknown> = {
        queue: this.queueName,
        dlq: this.dlqName ?? undefined,
        paused: this._paused,
        running: this.running,
        longPoll: this.useLongPoll,
      };
      try {
        const { rows } = await this.pool.query<{ queue_length: string; total_messages: string }>(
          'SELECT queue_length, total_messages FROM pgmq.metrics($1)',
          [this.queueName],
        );
        if (rows[0]) {
          details.queueLength = Number(rows[0].queue_length);
          details.totalMessages = Number(rows[0].total_messages);
        }
      } catch {
        // metrics are best effort
      }
      return { healthy: true, connected: true, latencyMs: Date.now() - start, details };
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
   * Get the underlying pool (for testing)
   */
  getPool(): Pool | null {
    return this.pool;
  }

  /**
   * Single message poll loop
   */
  private async poll(
    handler: MessageHandler<T>,
    opts: Required<SubscribeOptions>,
  ): Promise<void> {
    const qty = Math.min(Math.max(1, opts.concurrency), this.consumerOptions.maxMessages);

    while (this.running) {
      if (this._paused) {
        await this.sleep(this.consumerOptions.pollingInterval);
        continue;
      }

      try {
        const rows = await this.read(qty);
        if (rows.length === 0) {
          if (!this.useLongPoll) {
            await this.sleep(this.consumerOptions.pollingInterval);
          }
          continue;
        }

        // A long poll may return after pause() or disconnect() was called;
        // hand those leases straight back instead of invoking the handler.
        if (this._paused || !this.running) {
          await this.release(rows);
          continue;
        }

        for (let i = 0; i < rows.length; i++) {
          if (!this.running || this._paused) {
            await this.release(rows.slice(i));
            break;
          }
          await this.handleOne(rows[i], handler, opts);
        }
      } catch (error) {
        if (this.running) {
          this.logger.error('Error polling messages', {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(this.consumerOptions.pollingInterval);
        }
      }
    }
  }

  /**
   * Batch poll loop
   */
  private async pollBatch(
    handler: BatchMessageHandler<T>,
    opts: Required<SubscribeOptions>,
  ): Promise<void> {
    const qty = Math.min(Math.max(1, opts.batchSize), this.consumerOptions.maxMessages);

    while (this.running) {
      if (this._paused) {
        await this.sleep(this.consumerOptions.pollingInterval);
        continue;
      }

      try {
        const rows = await this.read(qty);
        if (rows.length === 0) {
          if (!this.useLongPoll) {
            await this.sleep(this.consumerOptions.pollingInterval);
          }
          continue;
        }

        if (this._paused || !this.running) {
          await this.release(rows);
          continue;
        }

        const messages = rows.map((row) => this.createWrappedMessage(row));

        try {
          await handler(messages);
          if (opts.autoAck) {
            await this.deleteMany(messages.map((m) => m.id));
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          // pgmq acks per message, so apply the strategy per message.
          for (const message of messages) {
            const result = await this.applyStrategy(message, err, () => handler([message]));
            if (!result.handled) {
              await this.legacyFailure(message, err);
            }
          }
        }
      } catch (error) {
        if (this.running) {
          this.logger.error('Error polling batch', {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(this.consumerOptions.pollingInterval);
        }
      }
    }
  }

  /**
   * Deliver one row to the handler and route any failure through the
   * configured strategy.
   */
  private async handleOne(
    row: PgmqRow,
    handler: MessageHandler<T>,
    opts: Required<SubscribeOptions>,
  ): Promise<void> {
    const message = this.createWrappedMessage(row);
    try {
      this.emit('message', message);
      await handler(message);
      if (opts.autoAck) {
        await message.ack();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const result = await this.applyStrategy(message, err, () => handler(message));
      if (!result.handled) {
        await this.legacyFailure(message, err);
      }
    }
  }

  /**
   * Behaviour when no `strategy` is configured: dead letter once
   * `deadLetterQueue.maxDeliveryAttempts` is reached, otherwise leave the
   * message alone so it reappears when its visibility timeout lapses.
   */
  private async legacyFailure(message: IMessage<T>, err: Error): Promise<void> {
    this.logger.error('Error processing message', {
      messageId: message.id,
      deliveryAttempt: message.deliveryAttempt,
      error: err.message,
    });
    this.emit('error', err);

    const max = this.config.deadLetterQueue?.maxDeliveryAttempts;
    if (this.dlqName && typeof max === 'number' && max > 0 && message.deliveryAttempt >= max) {
      await this.deadLetterMessage(message, err.message);
    }
  }

  /**
   * Read up to `qty` messages, leasing them for the visibility timeout.
   */
  private async read(qty: number): Promise<PgmqRow[]> {
    const pool = this.pool;
    if (!pool) {
      return [];
    }
    const vt = this.consumerOptions.visibilityTimeout;

    if (this.useLongPoll) {
      const { rows } = await pool.query<PgmqRow>(
        'SELECT * FROM pgmq.read_with_poll($1, $2::int, $3::int, $4::int, $5::int)',
        [
          this.queueName,
          vt,
          qty,
          this.consumerOptions.longPollSeconds,
          this.consumerOptions.longPollIntervalMs,
        ],
      );
      return rows;
    }

    const { rows } = await pool.query<PgmqRow>(
      'SELECT * FROM pgmq.read($1, $2::int, $3::int)',
      [this.queueName, vt, qty],
    );
    return rows;
  }

  /**
   * Return leased rows to the queue immediately (visibility timeout 0), used
   * when a read completes after pause() or disconnect().
   */
  private async release(rows: PgmqRow[]): Promise<void> {
    for (const row of rows) {
      try {
        await this.setVt(String(row.msg_id), 0);
      } catch (err) {
        this.logger.warn('Failed to release leased message; it will reappear after vt', {
          messageId: String(row.msg_id),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async deleteOne(msgId: string): Promise<void> {
    await this.pool?.query('SELECT pgmq.delete($1, $2::bigint)', [this.queueName, msgId]);
  }

  private async deleteMany(msgIds: string[]): Promise<void> {
    if (msgIds.length === 0) return;
    await this.pool?.query('SELECT pgmq.delete($1, $2::bigint[])', [this.queueName, msgIds]);
  }

  private async setVt(msgId: string, seconds: number): Promise<void> {
    await this.pool?.query('SELECT pgmq.set_vt($1, $2::bigint, $3::int)', [
      this.queueName,
      msgId,
      Math.max(0, Math.floor(seconds)),
    ]);
  }

  private async archiveOne(msgId: string): Promise<void> {
    await this.pool?.query('SELECT pgmq.archive($1, $2::bigint)', [this.queueName, msgId]);
  }

  /**
   * Wrap a pgmq row in the universal message interface.
   */
  private createWrappedMessage(row: PgmqRow): IMessage<T> {
    const msgId = String(row.msg_id);
    // pg parses jsonb into a value; re-stringify so the serializer contract
    // (string in, T out) holds for custom serializers too.
    const body = this.serializer.deserialize(JSON.stringify(row.message ?? null));
    const { headers, key } = unpackHeaders(row.headers);
    const readCount = Number(row.read_ct) || 1;
    const enqueuedAt = new Date(row.enqueued_at);
    const visibleAt = new Date(row.vt);

    return createMessage<T>({
      id: msgId,
      body,
      key,
      headers,
      timestamp: enqueuedAt,
      deliveryAttempt: readCount,
      metadata: {
        provider: 'pgmq',
        pgmq: {
          queueName: this.queueName,
          msgId,
          readCount,
          enqueuedAt,
          visibleAt,
        },
      },
      raw: row,
      onAck: async () => {
        await this.deleteOne(msgId);
        this.logger.debug('Message acknowledged', { messageId: msgId });
      },
      onNack: async (requeue = true) => {
        if (requeue) {
          await this.setVt(msgId, 0);
        } else {
          await this.archiveOne(msgId);
        }
        this.logger.debug('Message nacked', { messageId: msgId, requeue });
      },
      onExtendDeadline: async (seconds: number) => {
        // pgmq sets an absolute deadline from now, like SQS ChangeMessageVisibility.
        await this.setVt(msgId, seconds);
        this.logger.debug('Deadline extended', { messageId: msgId, seconds });
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
