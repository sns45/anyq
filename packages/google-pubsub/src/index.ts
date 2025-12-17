/**
 * @anyq/google-pubsub - Google Cloud Pub/Sub adapter for anyq
 *
 * Provides Google Cloud Pub/Sub integration for anyq
 */

export { PubSubProducer, createPubSubProducer } from './producer.js';
export { PubSubConsumer, createPubSubConsumer } from './consumer.js';
export {
  type PubSubConnectionConfig,
  type TopicConfig,
  type SubscriptionConfig,
  type PubSubProducerConfig,
  type PubSubConsumerConfig,
  PUBSUB_DEFAULTS,
} from './config.js';

// Re-export core types for convenience
export type {
  IProducer,
  IConsumer,
  IMessage,
  PublishOptions,
  MessageHandler,
  SubscribeOptions,
  GooglePubSubMetadata,
} from '@anyq/core';
