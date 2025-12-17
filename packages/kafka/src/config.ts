/**
 * @fileoverview Kafka adapter configuration
 * @module @anyq/kafka/config
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * Kafka broker configuration
 */
export interface KafkaBrokerConfig {
  /** Broker addresses (host:port) */
  brokers: string[];
  /** Client ID */
  clientId?: string;
  /** Connection timeout in ms. Default: 10000 */
  connectionTimeout?: number;
  /** Authentication timeout in ms. Default: 10000 */
  authenticationTimeout?: number;
  /** Request timeout in ms. Default: 30000 */
  requestTimeout?: number;
}

/**
 * SASL authentication configuration
 */
export interface KafkaSASLConfig {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
}

/**
 * SSL configuration
 */
export interface KafkaSSLConfig {
  /** Enable SSL/TLS */
  enabled: boolean;
  /** Reject unauthorized certificates. Default: true */
  rejectUnauthorized?: boolean;
  /** CA certificate (PEM format) */
  ca?: string;
  /** Client certificate (PEM format) */
  cert?: string;
  /** Client key (PEM format) */
  key?: string;
}

/**
 * Producer-specific configuration
 */
export interface KafkaProducerOptions {
  /** Acknowledgment level: 0, 1, -1 (all). Default: -1 */
  acks?: number;
  /** Request timeout in ms. Default: 30000 */
  timeout?: number;
  /** Compression type */
  compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
  /** Enable idempotent producer. Default: false */
  idempotent?: boolean;
  /** Max in-flight requests. Default: 5 */
  maxInFlightRequests?: number;
  /** Transaction ID for transactional producer */
  transactionalId?: string;
}

/**
 * Consumer group configuration
 */
export interface KafkaConsumerGroupConfig {
  /** Consumer group ID */
  groupId: string;
  /** Session timeout in ms. Default: 30000 */
  sessionTimeout?: number;
  /** Rebalance timeout in ms. Default: 60000 */
  rebalanceTimeout?: number;
  /** Heartbeat interval in ms. Default: 3000 */
  heartbeatInterval?: number;
  /** Max bytes per partition. Default: 1048576 (1MB) */
  maxBytesPerPartition?: number;
  /** Min bytes per fetch. Default: 1 */
  minBytes?: number;
  /** Max bytes per fetch. Default: 10485760 (10MB) */
  maxBytes?: number;
  /** Max wait time in ms. Default: 5000 */
  maxWaitTimeInMs?: number;
  /** Auto commit. Default: true */
  autoCommit?: boolean;
  /** Auto commit interval in ms. Default: 5000 */
  autoCommitInterval?: number;
  /** Auto commit threshold. Default: null */
  autoCommitThreshold?: number | null;
  /** From beginning. Default: false */
  fromBeginning?: boolean;
  /** Partition assigners */
  partitionAssigners?: string[];
}

/**
 * Kafka queue configuration
 */
export interface KafkaConfig extends BaseQueueConfig {
  driver: 'kafka';

  /** Kafka broker configuration */
  kafka: KafkaBrokerConfig;

  /** Topic name */
  topic: string;

  /** SASL authentication */
  sasl?: KafkaSASLConfig;

  /** SSL/TLS configuration */
  ssl?: KafkaSSLConfig;

  /** Producer options */
  producer?: KafkaProducerOptions;

  /** Consumer group configuration (required for consumers) */
  consumerGroup?: KafkaConsumerGroupConfig;

  /** Number of partitions to create (for admin operations) */
  numPartitions?: number;

  /** Replication factor (for admin operations) */
  replicationFactor?: number;
}

/**
 * Default Kafka configuration
 */
export const DEFAULT_KAFKA_CONFIG: Partial<KafkaConfig> = {
  driver: 'kafka',
  kafka: {
    brokers: ['localhost:9092'],
    clientId: 'anyq-client',
    connectionTimeout: 10000,
    requestTimeout: 30000,
  },
  producer: {
    acks: -1,
    timeout: 30000,
    compression: 'none',
    idempotent: false,
    maxInFlightRequests: 5,
  },
  consumerGroup: {
    groupId: 'anyq-consumer-group',
    sessionTimeout: 30000,
    rebalanceTimeout: 60000,
    heartbeatInterval: 3000,
    maxBytesPerPartition: 1048576,
    minBytes: 1,
    maxBytes: 10485760,
    maxWaitTimeInMs: 5000,
    autoCommit: true,
    autoCommitInterval: 5000,
    fromBeginning: false,
  },
};
