/**
 * @fileoverview Main entry point for @anyq/memory
 * @module @anyq/memory
 *
 * In-memory queue adapter for testing and development.
 *
 * @example
 * ```typescript
 * import { MemoryProducer, MemoryConsumer } from '@anyq/memory';
 *
 * // Create producer
 * const producer = new MemoryProducer({
 *   driver: 'memory',
 *   queueName: 'orders',
 * });
 *
 * // Create consumer
 * const consumer = new MemoryConsumer({
 *   driver: 'memory',
 *   queueName: 'orders',
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
export type { MemoryQueueConfig } from './config.js';
export { DEFAULT_MEMORY_CONFIG } from './config.js';

// Queue
export { MemoryQueue, type StoredMessage } from './queue.js';

// Producer and Consumer
import { MemoryProducer as _MemoryProducer } from './producer.js';
import { MemoryConsumer as _MemoryConsumer } from './consumer.js';
export { MemoryProducer } from './producer.js';
export { MemoryConsumer } from './consumer.js';

// Registry
export {
  getQueue,
  registerQueue,
  unregisterQueue,
  clearAllQueues,
  getQueueNames,
  getQueueStats,
} from './registry.js';

/**
 * Create a memory producer
 */
export function createMemoryProducer<T = unknown>(
  config: Partial<import('./config.js').MemoryQueueConfig> = {}
): _MemoryProducer<T> {
  return new _MemoryProducer<T>({
    driver: 'memory',
    ...config,
  } as import('./config.js').MemoryQueueConfig);
}

/**
 * Create a memory consumer
 */
export function createMemoryConsumer<T = unknown>(
  config: Partial<import('./config.js').MemoryQueueConfig> = {}
): _MemoryConsumer<T> {
  return new _MemoryConsumer<T>({
    driver: 'memory',
    ...config,
  } as import('./config.js').MemoryQueueConfig);
}
