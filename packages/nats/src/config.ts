/**
 * NATS JetStream Configuration
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * NATS connection options
 */
export interface NATSConnectionConfig {
  /** NATS server URLs (e.g., 'nats://localhost:4222') */
  servers: string | string[];
  /** Connection name for identification */
  name?: string;
  /** User for authentication */
  user?: string;
  /** Password for authentication */
  pass?: string;
  /** JWT token for authentication */
  token?: string;
  /** TLS configuration */
  tls?: {
    certFile?: string;
    keyFile?: string;
    caFile?: string;
  };
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
  /** Reconnect time wait in milliseconds */
  reconnectTimeWait?: number;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Ping interval in milliseconds */
  pingInterval?: number;
}

/**
 * JetStream configuration
 */
export interface JetStreamConfig {
  /** Stream name */
  stream: string;
  /** Subjects the stream listens to */
  subjects?: string[];
  /** Storage type: 'file' or 'memory' */
  storage?: 'file' | 'memory';
  /** Number of replicas for the stream */
  replicas?: number;
  /** Retention policy */
  retention?: 'limits' | 'interest' | 'workqueue';
  /** Maximum messages in the stream */
  maxMsgs?: number;
  /** Maximum bytes in the stream */
  maxBytes?: number;
  /** Maximum age of messages in nanoseconds */
  maxAge?: number;
  /** Discard policy when limits are reached */
  discard?: 'old' | 'new';
  /** Allow duplicate messages */
  duplicateWindow?: number;
}

/**
 * JetStream consumer options
 */
export interface JetStreamConsumerOptions {
  /** Durable consumer name (required for persistent consumers) */
  durableName?: string;
  /** Consumer description */
  description?: string;
  /** Deliver policy */
  deliverPolicy?: 'all' | 'last' | 'new' | 'byStartSequence' | 'byStartTime' | 'lastPerSubject';
  /** Optional start sequence for 'byStartSequence' policy */
  optStartSeq?: number;
  /** Optional start time for 'byStartTime' policy */
  optStartTime?: Date;
  /** Acknowledgment wait time in nanoseconds */
  ackWait?: number;
  /** Maximum number of delivery attempts */
  maxDeliver?: number;
  /** Filter subjects */
  filterSubject?: string;
  /** Maximum number of pending acknowledgments */
  maxAckPending?: number;
  /** Idle heartbeat interval in nanoseconds */
  idleHeartbeat?: number;
  /** Flow control */
  flowControl?: boolean;
  /** Maximum waiting pull requests */
  maxWaiting?: number;
  /** Replay policy */
  replayPolicy?: 'instant' | 'original';
  /** Number of messages to request in batch */
  batch?: number;
  /** Batch timeout in milliseconds */
  expires?: number;
}

/**
 * NATS Producer configuration
 */
export interface NATSProducerConfig extends BaseQueueConfig {
  /** NATS connection configuration */
  connection: NATSConnectionConfig;
  /** JetStream configuration */
  jetstream: JetStreamConfig;
  /** Subject to publish to */
  subject: string;
  /** Message ID header name for deduplication */
  msgIdHeader?: string;
  /** Expected stream for publish validation */
  expectedStream?: string;
}

/**
 * NATS Consumer configuration
 */
export interface NATSConsumerConfig extends BaseQueueConfig {
  /** NATS connection configuration */
  connection: NATSConnectionConfig;
  /** JetStream configuration */
  jetstream: JetStreamConfig;
  /** Subject to subscribe to */
  subject: string;
  /** Consumer options */
  consumer?: JetStreamConsumerOptions;
}

/**
 * Default NATS configuration values
 */
export const NATS_DEFAULTS = {
  connection: {
    servers: 'nats://localhost:4222',
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
    timeout: 10000,
    pingInterval: 60000,
  },
  jetstream: {
    storage: 'memory' as const,
    replicas: 1,
    retention: 'limits' as const,
    discard: 'old' as const,
  },
  consumer: {
    deliverPolicy: 'all' as const,
    ackWait: 30 * 1e9, // 30 seconds in nanoseconds
    maxDeliver: 5,
    maxAckPending: 1000,
    replayPolicy: 'instant' as const,
    batch: 10,
    expires: 5000,
  },
} as const;
