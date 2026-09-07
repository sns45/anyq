/**
 * @fileoverview Main entry point for @anyq/pgmq
 * @module @anyq/pgmq
 *
 * Postgres adapter for anyq, backed by pgmq (https://github.com/pgmq/pgmq).
 *
 * @example
 * ```typescript
 * import { createPgmqProducer, createPgmqConsumer } from '@anyq/pgmq';
 *
 * const pg = { connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' };
 *
 * const producer = createPgmqProducer({ queueName: 'orders', pg });
 * const consumer = createPgmqConsumer({ queueName: 'orders', pg });
 *
 * await producer.connect();
 * await consumer.connect();
 *
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body, 'attempt', message.deliveryAttempt);
 *   await message.ack();
 * });
 *
 * await producer.publish({ orderId: '123' });
 * await producer.publish({ orderId: '124' }, { delaySeconds: 60 });
 * ```
 */

// Config
export type {
  PgmqConfig,
  PgmqConnectionConfig,
  PgmqProducerOptions,
  PgmqConsumerOptions,
} from './config.js';
export { DEFAULT_PGMQ_CONFIG } from './config.js';

// Helpers that are useful to callers
export {
  KEY_HEADER,
  PGMQ_INSTALL_HINT,
  QUEUE_NAME_PATTERN,
  validateQueueName,
} from './client.js';
export type { PgmqRow } from './client.js';

// Producer and Consumer
import type { PgmqConfig as _PgmqConfig } from './config.js';
import { PgmqProducer as _PgmqProducer } from './producer.js';
import { PgmqConsumer as _PgmqConsumer } from './consumer.js';
export { PgmqProducer } from './producer.js';
export { PgmqConsumer } from './consumer.js';

/**
 * Create a pgmq producer
 */
export function createPgmqProducer<T = unknown>(
  config: Omit<_PgmqConfig, 'driver'>,
): _PgmqProducer<T> {
  return new _PgmqProducer<T>({ driver: 'pgmq', ...config } as _PgmqConfig);
}

/**
 * Create a pgmq consumer
 */
export function createPgmqConsumer<T = unknown>(
  config: Omit<_PgmqConfig, 'driver'>,
): _PgmqConsumer<T> {
  return new _PgmqConsumer<T>({ driver: 'pgmq', ...config } as _PgmqConfig);
}
