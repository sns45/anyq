/**
 * pgmq producer setup
 */

import { createPgmqProducer } from '@anyq/pgmq';
import { config } from './config.js';
import type { Order } from './types.js';

export const producer = createPgmqProducer<Order>({
  queueName: config.pgmq.queueName,
  pg: { connectionString: config.pgmq.connectionString },
});

export const producerStats = {
  publishedCount: 0,
  lastPublishedAt: null as Date | null,
};

export async function initProducer(): Promise<void> {
  await producer.connect();
  console.log(`[Producer] Connected to pgmq queue ${config.pgmq.queueName}`);
}
