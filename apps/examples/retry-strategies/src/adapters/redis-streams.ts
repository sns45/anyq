/**
 * Redis Streams adapter factory for retry-strategy integration tests.
 *
 * Connects to a Redis instance reachable at `host:port` (defaults
 * to `127.0.0.1:6379` — i.e. `apps/testers/redis-streams/docker-compose.yml`).
 *
 * Reachability is probed via `tcpReachable()`; integration tests use
 * the result to `test.skipIf` cleanly when no Redis is up.
 */

import {
  RedisStreamsProducer,
  RedisStreamsConsumer,
} from '@anyq/redis-streams';
import type { AdapterFactory } from '../examples/shared.js';
import { tcpReachable } from './reachable.js';

export const REDIS_DEFAULT_HOST = '127.0.0.1';
export const REDIS_DEFAULT_PORT = 6379;

export function isRedisReachable(
  host = REDIS_DEFAULT_HOST,
  port = REDIS_DEFAULT_PORT,
): Promise<boolean> {
  return tcpReachable(host, port, 500);
}

export interface RedisAdapterOptions {
  host?: string;
  port?: number;
}

export function createRedisStreamsAdapter(
  opts: RedisAdapterOptions = {},
): AdapterFactory {
  const host = opts.host ?? REDIS_DEFAULT_HOST;
  const port = opts.port ?? REDIS_DEFAULT_PORT;

  return {
    name: 'redis-streams',
    async create(topic, strategy) {
      const groupName = `${topic}-grp`;
      const consumerName = `consumer-${Date.now()}`;

      const producer = new RedisStreamsProducer<{ id: string; n: number }>({
        driver: 'redis-streams',
        streamName: topic,
        redis: { host, port },
        strategy,
      });
      const consumer = new RedisStreamsConsumer<{ id: string; n: number }>({
        driver: 'redis-streams',
        streamName: topic,
        consumerGroup: { groupName, consumerName, autoCreate: true, startId: '0' },
        redis: { host, port },
        blockTimeout: 100,
        strategy,
      });

      return {
        producer,
        consumer,
        cleanup: async () => {
          // Drop the stream after the test so subsequent runs see a clean slate.
          const Redis = (await import('ioredis')).default;
          const client = new Redis({ host, port, lazyConnect: true });
          try {
            await client.connect();
            await client.del(topic);
            await client.del(`${topic}-dlq`);
          } catch {
            // best-effort cleanup
          } finally {
            client.disconnect();
          }
        },
      };
    },
  };
}
