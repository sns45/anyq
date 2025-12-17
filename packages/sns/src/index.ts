/**
 * @fileoverview Main entry point for @anyq/sns
 * @module @anyq/sns
 *
 * AWS SNS adapter for anyq.
 * SNS is a publish-only system (fan-out pattern).
 * For consuming, subscribe SQS queues to SNS topics.
 *
 * @example
 * ```typescript
 * import { SNSProducer } from '@anyq/sns';
 *
 * // Create producer
 * const producer = new SNSProducer({
 *   driver: 'sns',
 *   topicArn: 'arn:aws:sns:us-east-1:123456789:my-topic',
 *   sns: { region: 'us-east-1' },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' });
 * await producer.disconnect();
 * ```
 */

// Config
export type {
  SNSConfig,
  SNSConnectionConfig,
  SNSProducerOptions,
  SNSMessageAttribute,
} from './config.js';
export { DEFAULT_SNS_CONFIG } from './config.js';

// Producer
import { SNSProducer as _SNSProducer } from './producer.js';
export { SNSProducer } from './producer.js';

/**
 * Create an SNS producer
 */
export function createSNSProducer<T = unknown>(
  config: Omit<import('./config.js').SNSConfig, 'driver'>
): _SNSProducer<T> {
  return new _SNSProducer<T>({
    driver: 'sns',
    ...config,
  } as import('./config.js').SNSConfig);
}
