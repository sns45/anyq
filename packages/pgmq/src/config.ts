/**
 * @fileoverview pgmq (Postgres) adapter configuration
 * @module @anyq/pgmq/config
 */

import type { BaseQueueConfig } from '@anyq/core';
import type { Pool } from 'pg';

/**
 * Postgres connection configuration.
 *
 * Either supply `connectionString` or the discrete fields. Anything not set
 * falls back to the `pg` library defaults (which honour `PG*` env vars).
 */
export interface PgmqConnectionConfig {
  /** Full connection URL, e.g. `postgres://user:pass@host:5432/db` */
  connectionString?: string;
  /** Host. Default: 'localhost' */
  host?: string;
  /** Port. Default: 5432 */
  port?: number;
  /** Role name */
  user?: string;
  /** Role password */
  password?: string;
  /** Database name */
  database?: string;
  /** TLS settings (true, or a node `tls.connect` options object) */
  ssl?: boolean | Record<string, unknown>;
  /** Maximum pooled connections. Default: 10 */
  max?: number;
  /** `application_name` reported to Postgres */
  applicationName?: string;
}

/**
 * pgmq producer options
 */
export interface PgmqProducerOptions {
  /** Default delay in seconds applied when `PublishOptions.delaySeconds` is absent. Default: 0 */
  delaySeconds?: number;
}

/**
 * pgmq consumer options
 */
export interface PgmqConsumerOptions {
  /**
   * Visibility timeout in seconds: how long a read message stays invisible
   * to other consumers while the handler runs. Default: 30
   */
  visibilityTimeout?: number;
  /** Sleep in ms between polls when the queue is empty (or long polling is off). Default: 1000 */
  pollingInterval?: number;
  /**
   * Server side long poll duration in seconds via `pgmq.read_with_poll`.
   * Set to 0 to use plain `pgmq.read` plus `pollingInterval`. Default: 5
   */
  longPollSeconds?: number;
  /** Interval in ms pgmq waits between checks inside a long poll. Default: 100 */
  longPollIntervalMs?: number;
  /** Upper bound on messages fetched per read, regardless of subscribe options. Default: 100 */
  maxMessages?: number;
}

/**
 * pgmq queue configuration
 */
export interface PgmqConfig extends BaseQueueConfig {
  driver: 'pgmq';

  /** Postgres connection settings (ignored when `pool` is supplied) */
  pg?: PgmqConnectionConfig;

  /**
   * An existing `pg.Pool` to reuse. The adapter will not end a pool it did
   * not create.
   */
  pool?: Pool;

  /**
   * pgmq queue name. Must match `^[a-zA-Z0-9_]{1,47}$` (pgmq's own limit,
   * since it becomes the `pgmq.q_<name>` table).
   */
  queueName: string;

  /** Create the queue (and the DLQ, when enabled) on connect. Default: true */
  autoCreate?: boolean;

  /**
   * Run `CREATE EXTENSION IF NOT EXISTS pgmq` when the `pgmq` schema is
   * missing. Default: true. When false, or when the extension cannot be
   * created, connect fails with an error naming the SQL only install path.
   */
  autoInstall?: boolean;

  /** Producer options */
  producer?: PgmqProducerOptions;

  /** Consumer options */
  consumer?: PgmqConsumerOptions;
}

/**
 * Default pgmq configuration
 */
export const DEFAULT_PGMQ_CONFIG: Partial<PgmqConfig> = {
  driver: 'pgmq',
  autoCreate: true,
  autoInstall: true,
  producer: {
    delaySeconds: 0,
  },
  consumer: {
    visibilityTimeout: 30,
    pollingInterval: 1000,
    longPollSeconds: 5,
    longPollIntervalMs: 100,
    maxMessages: 100,
  },
};
