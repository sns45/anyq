/**
 * Kafka adapter factory for retry-strategy integration tests.
 *
 * Defaults to `127.0.0.1:9092` — matches
 * `apps/testers/kafka/docker-compose.yml`. Each run creates a topic
 * scoped to the test name and deletes it on cleanup.
 */

import { KafkaProducer, KafkaConsumer } from '@anyq/kafka';
import type { AdapterFactory } from '../examples/shared.js';
import { tcpReachable } from './reachable.js';

export const KAFKA_DEFAULT_HOST = '127.0.0.1';
export const KAFKA_DEFAULT_PORT = 9092;

export function isKafkaReachable(
  host = KAFKA_DEFAULT_HOST,
  port = KAFKA_DEFAULT_PORT,
): Promise<boolean> {
  return tcpReachable(host, port, 500);
}

export interface KafkaAdapterOptions {
  host?: string;
  port?: number;
}

export function createKafkaAdapter(
  opts: KafkaAdapterOptions = {},
): AdapterFactory {
  const host = opts.host ?? KAFKA_DEFAULT_HOST;
  const port = opts.port ?? KAFKA_DEFAULT_PORT;
  const broker = `${host}:${port}`;

  return {
    name: 'kafka',
    async create(topic, strategy) {
      const groupId = `${topic}-grp-${Date.now()}`;

      // Pre-create the topic so the consumer can subscribe before the
      // first publish — kafkajs's auto-creation only kicks in on publish,
      // and the consumer subscribe path errors with
      // UNKNOWN_TOPIC_OR_PARTITION when the topic is missing.
      const { Kafka } = await import('kafkajs');
      const admin = new Kafka({
        brokers: [broker],
        clientId: `example-setup-${topic}`,
      }).admin();
      await admin.connect();
      try {
        await admin.createTopics({
          topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
          waitForLeaders: true,
        });
      } catch {
        // already exists
      }
      await admin.disconnect();

      const producer = new KafkaProducer<{ id: string; n: number }>({
        driver: 'kafka',
        kafka: { brokers: [broker], clientId: `example-producer-${topic}` },
        topic,
        strategy,
      });
      const consumer = new KafkaConsumer<{ id: string; n: number }>({
        driver: 'kafka',
        kafka: { brokers: [broker], clientId: `example-consumer-${topic}` },
        topic,
        consumerGroup: {
          groupId,
          sessionTimeout: 10000,
          heartbeatInterval: 3000,
          autoCommit: true,
          fromBeginning: true,
        },
        strategy,
      });

      return {
        producer,
        consumer,
        cleanup: async () => {
          // Best-effort topic delete using kafkajs admin client.
          const { Kafka } = await import('kafkajs');
          try {
            const admin = new Kafka({
              brokers: [broker],
              clientId: `example-cleanup-${topic}`,
            }).admin();
            await admin.connect();
            try {
              await admin.deleteTopics({ topics: [topic] });
            } catch {}
            await admin.disconnect();
          } catch {
            // ignore
          }
        },
      };
    },
  };
}
