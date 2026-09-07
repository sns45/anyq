/**
 * @fileoverview pgmq producer implementation
 * @module @anyq/pgmq/producer
 */

import type { Pool } from 'pg';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConfigurationError,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { PgmqConfig, PgmqProducerOptions } from './config.js';
import {
  asConnectionError,
  createPool,
  ensurePgmq,
  ensureQueue,
  packHeaders,
  toJsonText,
  validateQueueName,
} from './client.js';

/**
 * pgmq producer implementation
 *
 * Publishes messages to a pgmq queue with `pgmq.send` / `pgmq.send_batch`.
 * Delayed delivery is native: `delaySeconds` maps straight onto pgmq's
 * `delay` argument.
 *
 * @example
 * ```typescript
 * const producer = new PgmqProducer({
 *   driver: 'pgmq',
 *   queueName: 'orders',
 *   pg: { connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' }, { delaySeconds: 30 });
 * await producer.disconnect();
 * ```
 */
export class PgmqProducer<T = unknown> extends BaseProducer<T> {
  private pool: Pool | null = null;
  private ownsPool = false;
  private readonly queueName: string;
  private readonly producerOptions: PgmqProducerOptions;

  constructor(config: PgmqConfig) {
    super(config);
    this.queueName = validateQueueName(config.queueName);
    this.producerOptions = config.producer ?? {};
  }

  /**
   * Open the pool, verify pgmq, and create the queue when allowed.
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
      }
    } catch (error) {
      if (owned) {
        await pool.end().catch(() => undefined);
      }
      // ConfigurationError (pgmq missing) propagates as is; anything else is a
      // transport failure.
      if (error instanceof ConnectionError || error instanceof ConfigurationError) {
        throw error;
      }
      throw asConnectionError('Failed to connect to Postgres', error);
    }

    this.pool = pool;
    this.ownsPool = owned;
    this._connected = true;
    this.logger.info('pgmq producer connected', { queue: this.queueName });
  }

  /**
   * End the pool (only if this adapter created it).
   */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.pool) {
      return;
    }
    const pool = this.pool;
    this.pool = null;
    this._connected = false;
    if (this.ownsPool) {
      await pool.end().catch(() => undefined);
    }
    this.logger.info('pgmq producer disconnected');
  }

  /**
   * Publish a single message via `pgmq.send`.
   *
   * @returns the pgmq `msg_id` as a decimal string
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.pool) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const msg = toJsonText(this.serializer.serialize(body));
      const headers = JSON.stringify(packHeaders(options?.headers, options?.key));
      const delay = this.resolveDelay(options);

      const { rows } = await this.pool.query<{ msg_id: string }>(
        'SELECT pgmq.send($1, $2::jsonb, $3::jsonb, $4::int) AS msg_id',
        [this.queueName, msg, headers, delay],
      );

      const messageId = String(rows[0]?.msg_id);
      this.logger.debug('Message published', { messageId, queue: this.queueName, delay });
      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish many messages. Messages sharing a delay go out in one
   * `pgmq.send_batch`; ids are returned in the input order.
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>,
  ): Promise<string[]> {
    if (!this.pool) {
      throw new ConnectionError('Producer not connected');
    }
    if (messages.length === 0) {
      return [];
    }

    try {
      // Group indices by delay so each group is a single send_batch call.
      const groups = new Map<number, number[]>();
      messages.forEach((m, i) => {
        const delay = this.resolveDelay(m.options);
        const list = groups.get(delay);
        if (list) list.push(i);
        else groups.set(delay, [i]);
      });

      const ids: string[] = new Array(messages.length);
      for (const [delay, indices] of groups) {
        const msgs = indices.map((i) => toJsonText(this.serializer.serialize(messages[i].body)));
        const headers = indices.map((i) =>
          JSON.stringify(packHeaders(messages[i].options?.headers, messages[i].options?.key)),
        );
        const { rows } = await this.pool.query<{ msg_id: string }>(
          'SELECT pgmq.send_batch($1, $2::jsonb[], $3::jsonb[], $4::int) AS msg_id',
          [this.queueName, msgs, headers, delay],
        );
        if (rows.length !== indices.length) {
          throw new Error(`pgmq.send_batch returned ${rows.length} ids for ${indices.length} messages`);
        }
        rows.forEach((row, j) => {
          ids[indices[j]] = String(row.msg_id);
        });
      }

      this.logger.debug('Batch published', { count: ids.length, queue: this.queueName });
      return ids;
    } catch (error) {
      throw new PublishError('Failed to publish batch', {
        cause: error instanceof Error ? error : undefined,
      });
    }
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
      const details: Record<string, unknown> = { queue: this.queueName };
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

  private resolveDelay(options?: PublishOptions): number {
    const d = options?.delaySeconds ?? this.producerOptions.delaySeconds ?? 0;
    return Math.max(0, Math.floor(d));
  }
}
