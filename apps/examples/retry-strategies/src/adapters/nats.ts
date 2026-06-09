/**
 * NATS JetStream adapter factory for retry-strategy integration tests.
 *
 * Defaults to `nats://127.0.0.1:4222` — matches
 * `apps/testers/nats/docker-compose.yml`. Each run creates a JetStream
 * stream + pull consumer scoped to the test topic and tears them down.
 */

import { NATSProducer, NATSConsumer } from '@anyq/nats';
import type { AdapterFactory } from '../examples/shared.js';
import { tcpReachable } from './reachable.js';

export const NATS_DEFAULT_HOST = '127.0.0.1';
export const NATS_DEFAULT_PORT = 4222;

export function isNatsReachable(
  host = NATS_DEFAULT_HOST,
  port = NATS_DEFAULT_PORT,
): Promise<boolean> {
  return tcpReachable(host, port, 500);
}

export interface NATSAdapterOptions {
  host?: string;
  port?: number;
}

export function createNatsAdapter(
  opts: NATSAdapterOptions = {},
): AdapterFactory {
  const host = opts.host ?? NATS_DEFAULT_HOST;
  const port = opts.port ?? NATS_DEFAULT_PORT;
  const url = `nats://${host}:${port}`;

  return {
    name: 'nats',
    async create(topic, strategy) {
      // NATS subjects can't contain '-' restrictions, but '.' segments
      // are fine. Use the topic as both stream name and subject.
      const stream = topic.replace(/[^A-Za-z0-9_]/g, '_');
      const subject = stream;
      const durable = `${stream}-durable`;

      const producer = new NATSProducer<{ id: string; n: number }>({
        connection: { servers: url },
        jetstream: { stream, subjects: [subject], storage: 'memory' },
        subject,
        strategy,
      });
      const consumer = new NATSConsumer<{ id: string; n: number }>({
        connection: { servers: url },
        jetstream: { stream, subjects: [subject], storage: 'memory' },
        subject,
        consumer: { durableName: durable, ackWait: 1e9, maxDeliver: 3 },
        strategy,
      });

      return {
        producer,
        consumer,
        cleanup: async () => {
          // Best-effort teardown of the stream so subsequent runs start clean.
          const { connect } = await import('nats');
          try {
            const nc = await connect({ servers: url });
            const jsm = await nc.jetstreamManager();
            try {
              await jsm.streams.delete(stream);
            } catch {}
            await nc.close();
          } catch {
            // ignore
          }
        },
      };
    },
  };
}
