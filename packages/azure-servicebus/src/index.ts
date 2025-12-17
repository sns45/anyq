/**
 * @anyq/azure-servicebus - Azure Service Bus adapter for anyq
 *
 * Provides Azure Service Bus integration for anyq
 */

export { ServiceBusProducer, createServiceBusProducer } from './producer.js';
export { ServiceBusConsumer, createServiceBusConsumer } from './consumer.js';
export {
  type ServiceBusConnectionConfig,
  type ServiceBusQueueConfig,
  type ServiceBusTopicConfig,
  type ServiceBusSubscriptionConfig,
  type ServiceBusReceiverOptions,
  type ServiceBusSenderOptions,
  type ServiceBusProducerConfig,
  type ServiceBusConsumerConfig,
  SERVICEBUS_DEFAULTS,
} from './config.js';

// Re-export core types for convenience
export type {
  IProducer,
  IConsumer,
  IMessage,
  PublishOptions,
  MessageHandler,
  SubscribeOptions,
  AzureServiceBusMetadata,
} from '@anyq/core';
