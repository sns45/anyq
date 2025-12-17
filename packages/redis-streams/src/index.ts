/**
 * @fileoverview Main entry point for @anyq/redis-streams
 * @module @anyq/redis-streams
 *
 * Redis Streams adapter for anyq.
 *
 * @example
 * ```typescript
 * import { RedisStreamsProducer, RedisStreamsConsumer } from '@anyq/redis-streams';
 *
 * // Create producer
 * const producer = new RedisStreamsProducer({
 *   driver: 'redis-streams',
 *   streamName: 'orders',
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * // Create consumer
 * const consumer = new RedisStreamsConsumer({
 *   driver: 'redis-streams',
 *   streamName: 'orders',
 *   consumerGroup: {
 *     groupName: 'order-processors',
 *     consumerName: 'consumer-1',
 *   },
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * await producer.connect();
 * await consumer.connect();
 *
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 *
 * await producer.publish({ orderId: '123' });
 * ```
 */

// Config
export type {
  RedisStreamsConfig,
  RedisConnectionConfig,
  ConsumerGroupConfig,
} from './config.js';
export { DEFAULT_REDIS_STREAMS_CONFIG } from './config.js';

// Producer and Consumer
import { RedisStreamsProducer as _RedisStreamsProducer } from './producer.js';
import { RedisStreamsConsumer as _RedisStreamsConsumer } from './consumer.js';
export { RedisStreamsProducer } from './producer.js';
export { RedisStreamsConsumer } from './consumer.js';

/**
 * Create a Redis Streams producer
 */
export function createRedisStreamsProducer<T = unknown>(
  config: Omit<import('./config.js').RedisStreamsConfig, 'driver'>
): _RedisStreamsProducer<T> {
  return new _RedisStreamsProducer<T>({
    driver: 'redis-streams',
    ...config,
  } as import('./config.js').RedisStreamsConfig);
}

/**
 * Create a Redis Streams consumer
 */
export function createRedisStreamsConsumer<T = unknown>(
  config: Omit<import('./config.js').RedisStreamsConfig, 'driver'>
): _RedisStreamsConsumer<T> {
  return new _RedisStreamsConsumer<T>({
    driver: 'redis-streams',
    ...config,
  } as import('./config.js').RedisStreamsConfig);
}
