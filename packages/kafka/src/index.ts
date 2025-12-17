/**
 * @fileoverview Main entry point for @anyq/kafka
 * @module @anyq/kafka
 *
 * Apache Kafka adapter for anyq.
 *
 * @example
 * ```typescript
 * import { KafkaProducer, KafkaConsumer } from '@anyq/kafka';
 *
 * // Create producer
 * const producer = new KafkaProducer({
 *   driver: 'kafka',
 *   topic: 'orders',
 *   kafka: { brokers: ['localhost:9092'] },
 * });
 *
 * // Create consumer
 * const consumer = new KafkaConsumer({
 *   driver: 'kafka',
 *   topic: 'orders',
 *   kafka: { brokers: ['localhost:9092'] },
 *   consumerGroup: { groupId: 'order-processors' },
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
  KafkaConfig,
  KafkaBrokerConfig,
  KafkaSASLConfig,
  KafkaSSLConfig,
  KafkaProducerOptions,
  KafkaConsumerGroupConfig,
} from './config.js';
export { DEFAULT_KAFKA_CONFIG } from './config.js';

// Producer and Consumer
import { KafkaProducer as _KafkaProducer } from './producer.js';
import { KafkaConsumer as _KafkaConsumer } from './consumer.js';
export { KafkaProducer } from './producer.js';
export { KafkaConsumer } from './consumer.js';

/**
 * Create a Kafka producer
 */
export function createKafkaProducer<T = unknown>(
  config: Omit<import('./config.js').KafkaConfig, 'driver'>
): _KafkaProducer<T> {
  return new _KafkaProducer<T>({
    driver: 'kafka',
    ...config,
  } as import('./config.js').KafkaConfig);
}

/**
 * Create a Kafka consumer
 */
export function createKafkaConsumer<T = unknown>(
  config: Omit<import('./config.js').KafkaConfig, 'driver'>
): _KafkaConsumer<T> {
  return new _KafkaConsumer<T>({
    driver: 'kafka',
    ...config,
  } as import('./config.js').KafkaConfig);
}
