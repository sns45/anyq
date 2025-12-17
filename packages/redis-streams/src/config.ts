/**
 * @fileoverview Redis Streams adapter configuration
 * @module @anyq/redis-streams/config
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * Redis connection configuration
 */
export interface RedisConnectionConfig {
  /** Redis host. Default: 'localhost' */
  host?: string;
  /** Redis port. Default: 6379 */
  port?: number;
  /** Redis password */
  password?: string;
  /** Redis database number. Default: 0 */
  db?: number;
  /** Redis username (for Redis 6+ ACL) */
  username?: string;
  /** Enable TLS/SSL */
  tls?: boolean;
  /** Connection URL (overrides other options if provided) */
  url?: string;
  /** Key prefix for all keys */
  keyPrefix?: string;
  /** Connection name for CLIENT SETNAME */
  connectionName?: string;
}

/**
 * Consumer group configuration
 */
export interface ConsumerGroupConfig {
  /** Consumer group name */
  groupName: string;
  /** Consumer name within the group */
  consumerName: string;
  /** Create group if it doesn't exist. Default: true */
  autoCreate?: boolean;
  /** Start reading from ($ = new, 0 = beginning). Default: '0' */
  startId?: string;
}

/**
 * Redis Streams queue configuration
 */
export interface RedisStreamsConfig extends BaseQueueConfig {
  driver: 'redis-streams';

  /** Redis connection settings */
  redis?: RedisConnectionConfig;

  /** Stream name (the key in Redis) */
  streamName: string;

  /** Consumer group settings (required for consumers) */
  consumerGroup?: ConsumerGroupConfig;

  /** Maximum stream length (MAXLEN). 0 = unlimited. Default: 0 */
  maxStreamLength?: number;

  /** Approximate trimming (~). Default: true */
  approximateTrimming?: boolean;

  /** Block timeout in milliseconds for XREADGROUP. Default: 5000 */
  blockTimeout?: number;

  /** Number of messages to read per batch. Default: 10 */
  batchSize?: number;

  /** Auto-claim messages older than this (ms). 0 = disabled. Default: 30000 */
  claimTimeout?: number;

  /** Minimum idle time for auto-claim (ms). Default: 10000 */
  minIdleTime?: number;
}

/**
 * Default Redis Streams configuration
 */
export const DEFAULT_REDIS_STREAMS_CONFIG: Partial<RedisStreamsConfig> = {
  driver: 'redis-streams',
  redis: {
    host: 'localhost',
    port: 6379,
    db: 0,
  },
  maxStreamLength: 0,
  approximateTrimming: true,
  blockTimeout: 5000,
  batchSize: 10,
  claimTimeout: 30000,
  minIdleTime: 10000,
};
