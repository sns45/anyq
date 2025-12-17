/**
 * RabbitMQ Configuration
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * RabbitMQ connection options
 */
export interface RabbitMQConnectionConfig {
  /** Connection URL (e.g., 'amqp://localhost:5672') */
  url: string;
  /** Virtual host */
  vhost?: string;
  /** Username */
  username?: string;
  /** Password */
  password?: string;
  /** Heartbeat interval in seconds */
  heartbeat?: number;
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Channel max */
  channelMax?: number;
  /** Frame max */
  frameMax?: number;
}

/**
 * Exchange configuration
 */
export interface ExchangeConfig {
  /** Exchange name */
  name: string;
  /** Exchange type: 'direct', 'topic', 'fanout', 'headers' */
  type: 'direct' | 'topic' | 'fanout' | 'headers';
  /** Durable exchange survives broker restart */
  durable?: boolean;
  /** Auto-delete exchange when no queues are bound */
  autoDelete?: boolean;
  /** Internal exchange (can't be published to directly) */
  internal?: boolean;
  /** Additional arguments */
  arguments?: Record<string, unknown>;
}

/**
 * Queue configuration
 */
export interface QueueConfig {
  /** Queue name (empty string for server-generated name) */
  name: string;
  /** Durable queue survives broker restart */
  durable?: boolean;
  /** Exclusive queue for this connection only */
  exclusive?: boolean;
  /** Auto-delete queue when all consumers disconnect */
  autoDelete?: boolean;
  /** Dead letter exchange */
  deadLetterExchange?: string;
  /** Dead letter routing key */
  deadLetterRoutingKey?: string;
  /** Message TTL in milliseconds */
  messageTtl?: number;
  /** Maximum queue length */
  maxLength?: number;
  /** Maximum queue size in bytes */
  maxLengthBytes?: number;
  /** Additional arguments */
  arguments?: Record<string, unknown>;
}

/**
 * Consumer options
 */
export interface ConsumerOptions {
  /** Prefetch count (QoS) */
  prefetch?: number;
  /** Consumer tag */
  consumerTag?: string;
  /** No local (don't receive own messages) */
  noLocal?: boolean;
  /** No ack (auto-acknowledge) */
  noAck?: boolean;
  /** Exclusive consumer */
  exclusive?: boolean;
  /** Priority */
  priority?: number;
  /** Additional arguments */
  arguments?: Record<string, unknown>;
}

/**
 * RabbitMQ Producer configuration
 */
export interface RabbitMQProducerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: RabbitMQConnectionConfig;
  /** Exchange configuration */
  exchange: ExchangeConfig;
  /** Default routing key */
  routingKey?: string;
  /** Confirm mode for reliable publishing */
  confirmMode?: boolean;
  /** Publisher confirms timeout in milliseconds */
  confirmTimeout?: number;
  /** Mandatory flag (return unroutable messages) */
  mandatory?: boolean;
  /** Persistent messages by default */
  persistent?: boolean;
}

/**
 * RabbitMQ Consumer configuration
 */
export interface RabbitMQConsumerConfig extends BaseQueueConfig {
  /** Connection configuration */
  connection: RabbitMQConnectionConfig;
  /** Queue configuration */
  queue: QueueConfig;
  /** Exchange to bind to (optional) */
  exchange?: ExchangeConfig;
  /** Routing key or pattern for binding */
  bindingKey?: string;
  /** Consumer options */
  consumer?: ConsumerOptions;
}

/**
 * Default configuration values
 */
export const RABBITMQ_DEFAULTS = {
  connection: {
    heartbeat: 60,
    connectionTimeout: 30000,
  },
  exchange: {
    type: 'direct' as const,
    durable: true,
    autoDelete: false,
  },
  queue: {
    durable: true,
    exclusive: false,
    autoDelete: false,
  },
  consumer: {
    prefetch: 10,
    noAck: false,
    exclusive: false,
  },
  producer: {
    confirmMode: true,
    confirmTimeout: 5000,
    persistent: true,
  },
} as const;
