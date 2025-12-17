/**
 * @fileoverview Configuration for Redis Streams tester
 */

import type { RedisStreamsConfig } from '@anyq/redis-streams';

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  streamName: process.env.STREAM_NAME ?? 'orders',
  consumerGroup: process.env.CONSUMER_GROUP ?? 'order-processors',
  consumerName: process.env.CONSUMER_NAME ?? `consumer-${process.pid}`,
};

export const producerConfig: RedisStreamsConfig = {
  driver: 'redis-streams',
  streamName: config.streamName,
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  maxStreamLength: 10000,
  approximateTrimming: true,
  logging: {
    enabled: true,
    level: 'info',
  },
};

export const consumerConfig: RedisStreamsConfig = {
  driver: 'redis-streams',
  streamName: config.streamName,
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  consumerGroup: {
    groupName: config.consumerGroup,
    consumerName: config.consumerName,
    autoCreate: true,
    startId: '0',
  },
  blockTimeout: 5000,
  batchSize: 10,
  claimTimeout: 30000,
  minIdleTime: 10000,
  logging: {
    enabled: true,
    level: 'info',
  },
};
