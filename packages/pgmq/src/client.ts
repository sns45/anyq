/**
 * @fileoverview Shared Postgres/pgmq helpers for producer and consumer
 * @module @anyq/pgmq/client
 */

import pg from 'pg';
import type { Pool } from 'pg';
import { ConfigurationError, ConnectionError, type MessageHeaders } from '@anyq/core';
import type { PgmqConfig } from './config.js';

/** pgmq caps queue names at 47 characters and only allows word characters. */
export const QUEUE_NAME_PATTERN = /^[a-zA-Z0-9_]{1,47}$/;

/** Reserved header carrying the anyq routing key through pgmq's headers column. */
export const KEY_HEADER = 'x-anyq-key';

/** Where to point people who cannot `CREATE EXTENSION`. */
export const PGMQ_INSTALL_HINT =
  'pgmq is not installed in this database. Install the extension (CREATE EXTENSION pgmq), ' +
  'or run the SQL only install: psql -f pgmq-extension/sql/pgmq.sql <connection-url> ' +
  'from https://github.com/pgmq/pgmq (no extension privileges required).';

/**
 * Validate a pgmq queue name. Names are passed to pgmq functions as SQL
 * parameters, never interpolated, so this is defence in depth against pgmq's
 * own `format()` of the table name.
 */
export function validateQueueName(name: string, what = 'queueName'): string {
  if (typeof name !== 'string' || !QUEUE_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      `${what} must match ${QUEUE_NAME_PATTERN} (pgmq limit); got ${JSON.stringify(name)}`,
      { [what]: name },
    );
  }
  return name;
}

/**
 * Build (or reuse) a pg Pool from the adapter config.
 *
 * @returns the pool and whether this adapter owns it (and must end it).
 */
export function createPool(config: PgmqConfig): { pool: Pool; owned: boolean } {
  if (config.pool) {
    return { pool: config.pool, owned: false };
  }
  const c = config.pg ?? {};
  const pool = new pg.Pool({
    connectionString: c.connectionString,
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    ssl: c.ssl as pg.PoolConfig['ssl'],
    max: c.max ?? 10,
    application_name: c.applicationName ?? config.clientId ?? 'anyq-pgmq',
    connectionTimeoutMillis: config.connectionTimeout,
  });
  return { pool, owned: true };
}

/**
 * Verify pgmq is present, installing it when allowed.
 *
 * Detection looks for `pgmq.read` rather than `pg_extension`, so a SQL only
 * install (no extension row) is recognised.
 */
export async function ensurePgmq(pool: Pool, autoInstall: boolean): Promise<void> {
  const present = async (): Promise<boolean> => {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pgmq' AND p.proname = 'read'
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  };

  if (await present()) {
    return;
  }

  if (!autoInstall) {
    throw new ConfigurationError(PGMQ_INSTALL_HINT, { autoInstall });
  }

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgmq');
  } catch (error) {
    throw new ConfigurationError(
      `CREATE EXTENSION pgmq failed (${error instanceof Error ? error.message : String(error)}). ${PGMQ_INSTALL_HINT}`,
      { autoInstall },
    );
  }

  if (!(await present())) {
    throw new ConfigurationError(PGMQ_INSTALL_HINT, { autoInstall });
  }
}

/**
 * Create a queue if it does not exist. pgmq's `create` is idempotent.
 */
export async function ensureQueue(pool: Pool, queueName: string): Promise<void> {
  await pool.query('SELECT pgmq.create($1)', [queueName]);
}

/**
 * Detect `pgmq.read_with_poll` (present in pgmq 1.x; absent in some SQL only
 * installs of older versions).
 */
export async function hasReadWithPoll(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'pgmq' AND p.proname = 'read_with_poll'
     ) AS ok`,
  );
  return rows[0]?.ok === true;
}

/**
 * Wrap a driver error in the core ConnectionError.
 */
export function asConnectionError(message: string, error: unknown): ConnectionError {
  return new ConnectionError(message, error instanceof Error ? error : undefined);
}

/**
 * Flatten anyq headers (string | Buffer | undefined) plus the optional key
 * into the JSON object stored in pgmq's `headers` column.
 */
export function packHeaders(
  headers: MessageHeaders | undefined,
  key: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      out[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    }
  }
  if (key !== undefined) {
    out[KEY_HEADER] = key;
  }
  return out;
}

/**
 * Inverse of {@link packHeaders}: split the stored object back into anyq
 * headers and the routing key.
 */
export function unpackHeaders(
  stored: Record<string, unknown> | null | undefined,
): { headers: MessageHeaders; key?: string } {
  const headers: MessageHeaders = {};
  let key: string | undefined;
  if (stored && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored)) {
      if (k === KEY_HEADER) {
        key = typeof v === 'string' ? v : String(v);
        continue;
      }
      headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return { headers, key };
}

/**
 * Normalise a serializer result to the JSON text pgmq stores as jsonb.
 */
export function toJsonText(serialized: Buffer | string): string {
  return Buffer.isBuffer(serialized) ? serialized.toString('utf8') : serialized;
}

/**
 * Shape of a row returned by `pgmq.read` / `pgmq.read_with_poll`.
 * `msg_id` arrives as a string because pg does not coerce bigint.
 */
export interface PgmqRow {
  msg_id: string;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: unknown;
  headers: Record<string, unknown> | null;
}
