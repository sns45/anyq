/**
 * @fileoverview Type exports for @anyq/core
 * @module @anyq/core/types
 */

// Config types
export type {
  QueueDriver,
  RetryConfig,
  CircuitBreakerConfig,
  DeadLetterConfig,
  LogLevel,
  Logger,
  LogConfig,
  BaseQueueConfig,
} from './config.js';

export {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_REQUEST_TIMEOUT,
} from './config.js';

// Message types
export type {
  MessageHeaders,
  KafkaMetadata,
  SQSMetadata,
  RabbitMQMetadata,
  GooglePubSubMetadata,
  AzureServiceBusMetadata,
  RedisStreamsMetadata,
  NATSMetadata,
  MemoryMetadata,
  ProviderMetadata,
  IMessage,
  MessageCreateParams,
  MessageFactory,
} from './message.js';

// Producer types
export type {
  PublishOptions,
  HealthStatus,
  IProducer,
  TransactionContext,
  ITransactionalProducer,
} from './producer.js';

// Consumer types
export type {
  MessageHandler,
  BatchMessageHandler,
  SubscribeOptions,
  SeekPosition,
  PartitionLag,
  ConsumerLag,
  ConsumerEvents,
  IConsumerEventEmitter,
  IConsumer,
} from './consumer.js';

// Error types
export {
  AnyQError,
  ConnectionError,
  SerializationError,
  PublishError,
  ConsumeError,
  CircuitOpenError,
  ConfigurationError,
  TimeoutError,
  SchemaValidationError,
  NotImplementedError,
} from './errors.js';
