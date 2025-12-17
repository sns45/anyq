/**
 * @fileoverview Main entry point for @anyq/sqs
 * @module @anyq/sqs
 *
 * AWS SQS adapter for anyq.
 *
 * @example
 * ```typescript
 * import { SQSProducer, SQSConsumer } from '@anyq/sqs';
 *
 * // Create producer
 * const producer = new SQSProducer({
 *   driver: 'sqs',
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
 *   sqs: { region: 'us-east-1' },
 * });
 *
 * // Create consumer
 * const consumer = new SQSConsumer({
 *   driver: 'sqs',
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
 *   sqs: { region: 'us-east-1' },
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
  SQSConfig,
  SQSConnectionConfig,
  SQSProducerOptions,
  SQSConsumerOptions,
} from './config.js';
export { DEFAULT_SQS_CONFIG } from './config.js';

// Producer and Consumer
import { SQSProducer as _SQSProducer } from './producer.js';
import { SQSConsumer as _SQSConsumer } from './consumer.js';
export { SQSProducer } from './producer.js';
export { SQSConsumer } from './consumer.js';

/**
 * Create an SQS producer
 */
export function createSQSProducer<T = unknown>(
  config: Omit<import('./config.js').SQSConfig, 'driver'>
): _SQSProducer<T> {
  return new _SQSProducer<T>({
    driver: 'sqs',
    ...config,
  } as import('./config.js').SQSConfig);
}

/**
 * Create an SQS consumer
 */
export function createSQSConsumer<T = unknown>(
  config: Omit<import('./config.js').SQSConfig, 'driver'>
): _SQSConsumer<T> {
  return new _SQSConsumer<T>({
    driver: 'sqs',
    ...config,
  } as import('./config.js').SQSConfig);
}
