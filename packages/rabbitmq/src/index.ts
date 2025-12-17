/**
 * @anyq/rabbitmq - RabbitMQ adapter for anyq
 *
 * Provides RabbitMQ AMQP integration for anyq
 */

export { RabbitMQProducer, createRabbitMQProducer } from './producer.js';
export { RabbitMQConsumer, createRabbitMQConsumer } from './consumer.js';
export {
  type RabbitMQConnectionConfig,
  type ExchangeConfig,
  type QueueConfig,
  type ConsumerOptions,
  type RabbitMQProducerConfig,
  type RabbitMQConsumerConfig,
  RABBITMQ_DEFAULTS,
} from './config.js';

// Re-export core types for convenience
export type {
  IProducer,
  IConsumer,
  IMessage,
  PublishOptions,
  MessageHandler,
  SubscribeOptions,
  RabbitMQMetadata,
} from '@anyq/core';
