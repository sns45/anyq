/**
 * Azure Service Bus Configuration
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * Azure Service Bus connection options
 */
export interface ServiceBusConnectionConfig {
  /** Connection string (includes endpoint, access key, etc.) */
  connectionString: string;
}

/**
 * Queue configuration for Service Bus
 */
export interface ServiceBusQueueConfig {
  /** Queue name */
  name: string;
}

/**
 * Topic configuration for Service Bus
 */
export interface ServiceBusTopicConfig {
  /** Topic name */
  name: string;
}

/**
 * Subscription configuration for Service Bus
 */
export interface ServiceBusSubscriptionConfig {
  /** Topic name */
  topicName: string;
  /** Subscription name */
  subscriptionName: string;
}

/**
 * Receiver options
 */
export interface ServiceBusReceiverOptions {
  /** Receive mode: 'peekLock' (default) or 'receiveAndDelete' */
  receiveMode?: 'peekLock' | 'receiveAndDelete';
  /** Max auto-lock renewal duration in milliseconds */
  maxAutoLockRenewalDurationMs?: number;
  /** Sub-queue type for dead letter queue access */
  subQueueType?: 'deadLetter' | 'transferDeadLetter';
}

/**
 * Sender options
 */
export interface ServiceBusSenderOptions {
  /** Whether to send via topic instead of queue */
  useTopic?: boolean;
}

/**
 * Azure Service Bus Producer configuration
 */
export interface ServiceBusProducerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: ServiceBusConnectionConfig;
  /** Queue configuration (for direct queue sending) */
  queue?: ServiceBusQueueConfig;
  /** Topic configuration (for topic-based sending) */
  topic?: ServiceBusTopicConfig;
  /** Sender options */
  sender?: ServiceBusSenderOptions;
}

/**
 * Azure Service Bus Consumer configuration
 */
export interface ServiceBusConsumerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: ServiceBusConnectionConfig;
  /** Queue configuration (for queue receiving) */
  queue?: ServiceBusQueueConfig;
  /** Subscription configuration (for topic subscription receiving) */
  subscription?: ServiceBusSubscriptionConfig;
  /** Receiver options */
  receiver?: ServiceBusReceiverOptions;
  /** Max concurrent calls (number of messages to process concurrently) */
  maxConcurrentCalls?: number;
}

/**
 * Default configuration values
 */
export const SERVICEBUS_DEFAULTS = {
  receiver: {
    receiveMode: 'peekLock' as const,
    maxAutoLockRenewalDurationMs: 300000, // 5 minutes
  },
  maxConcurrentCalls: 10,
} as const;
