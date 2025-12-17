/**
 * Kafka producer setup
 */

import { createKafkaProducer } from '@anyq/kafka';
import { config } from './config.js';
import type { Order } from './types.js';

export const producer = createKafkaProducer<Order>({
  topic: config.kafka.topic,
  kafka: {
    brokers: config.kafka.brokers,
    clientId: config.kafka.clientId,
  },
  producer: {
    acks: -1,
    compression: 'gzip',
  },
});

export const producerStats = {
  publishedCount: 0,
  lastPublishedAt: null as Date | null,
};

export async function initProducer(): Promise<void> {
  await producer.connect();
  console.log(`[Producer] Connected to Kafka at ${config.kafka.brokers.join(', ')}`);
}
