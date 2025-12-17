/**
 * @anyq/nats - NATS JetStream adapter for anyq
 *
 * Provides persistent messaging with NATS JetStream
 */

export { NATSProducer, createNATSProducer } from './producer.js';
export { NATSConsumer, createNATSConsumer } from './consumer.js';
export {
  type NATSConnectionConfig,
  type JetStreamConfig,
  type JetStreamConsumerOptions,
  type NATSProducerConfig,
  type NATSConsumerConfig,
  NATS_DEFAULTS,
} from './config.js';

// Re-export core types for convenience
export type {
  IProducer,
  IConsumer,
  IMessage,
  PublishOptions,
  MessageHandler,
  SubscribeOptions,
  NATSMetadata,
} from '@anyq/core';
