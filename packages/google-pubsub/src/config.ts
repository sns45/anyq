/**
 * Google Cloud Pub/Sub Configuration
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * Google Cloud Pub/Sub connection options
 */
export interface PubSubConnectionConfig {
  /** GCP Project ID */
  projectId: string;
  /** Path to service account key file (optional if using default credentials) */
  keyFilename?: string;
  /** API endpoint override (for emulator) */
  apiEndpoint?: string;
  /** Enable emulator mode */
  emulatorMode?: boolean;
}

/**
 * Topic configuration
 */
export interface TopicConfig {
  /** Topic name or full resource name */
  name: string;
  /** Auto-create topic if it doesn't exist */
  autoCreate?: boolean;
  /** Enable message ordering */
  enableMessageOrdering?: boolean;
}

/**
 * Subscription configuration
 */
export interface SubscriptionConfig {
  /** Subscription name or full resource name */
  name: string;
  /** Auto-create subscription if it doesn't exist */
  autoCreate?: boolean;
  /** Acknowledgment deadline in seconds */
  ackDeadlineSeconds?: number;
  /** Enable exactly-once delivery */
  exactlyOnceDelivery?: boolean;
  /** Dead letter policy */
  deadLetterPolicy?: {
    /** Dead letter topic name */
    deadLetterTopic: string;
    /** Maximum delivery attempts before sending to DLT */
    maxDeliveryAttempts: number;
  };
  /** Retry policy */
  retryPolicy?: {
    /** Minimum backoff in seconds */
    minimumBackoff: number;
    /** Maximum backoff in seconds */
    maximumBackoff: number;
  };
  /** Flow control settings */
  flowControl?: {
    /** Maximum number of outstanding messages */
    maxMessages?: number;
    /** Maximum outstanding bytes */
    maxBytes?: number;
  };
}

/**
 * Google Pub/Sub Producer configuration
 */
export interface PubSubProducerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: PubSubConnectionConfig;
  /** Topic configuration */
  topic: TopicConfig;
  /** Batching settings */
  batching?: {
    /** Maximum messages in a batch */
    maxMessages?: number;
    /** Maximum batch size in bytes */
    maxBytes?: number;
    /** Maximum delay before sending batch (milliseconds) */
    maxMilliseconds?: number;
  };
}

/**
 * Google Pub/Sub Consumer configuration
 */
export interface PubSubConsumerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: PubSubConnectionConfig;
  /** Subscription configuration */
  subscription: SubscriptionConfig;
  /** Topic name (for auto-creation) */
  topicName?: string;
}

/**
 * Default configuration values
 */
export const PUBSUB_DEFAULTS = {
  topic: {
    autoCreate: true,
    enableMessageOrdering: false,
  },
  subscription: {
    autoCreate: true,
    ackDeadlineSeconds: 30,
    exactlyOnceDelivery: false,
  },
  batching: {
    maxMessages: 100,
    maxBytes: 1024 * 1024, // 1MB
    maxMilliseconds: 10,
  },
  flowControl: {
    maxMessages: 1000,
    maxBytes: 100 * 1024 * 1024, // 100MB
  },
} as const;
