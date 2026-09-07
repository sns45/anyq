/**
 * pgmq consumer setup
 */

import { createPgmqConsumer } from '@anyq/pgmq';
import { config } from './config.js';
import type { Order, ConsumedMessage } from './types.js';

export const consumer = createPgmqConsumer<Order>({
  queueName: config.pgmq.queueName,
  pg: { connectionString: config.pgmq.connectionString },
  consumer: {
    visibilityTimeout: 30,
    longPollSeconds: 5,
  },
  deadLetterQueue: {
    enabled: true,
    destination: `${config.pgmq.queueName}_dlq`,
    maxDeliveryAttempts: 3,
    includeError: true,
  },
});

export const consumedMessages: ConsumedMessage[] = [];
const MAX_STORED_MESSAGES = 100;

export const consumerStats = {
  consumedCount: 0,
  lastConsumedAt: null as Date | null,
};

export async function initConsumer(): Promise<void> {
  await consumer.connect();
  console.log(`[Consumer] Connected to pgmq queue ${config.pgmq.queueName}`);

  await consumer.subscribe(async (message) => {
    const consumed: ConsumedMessage = {
      id: message.id,
      body: message.body,
      receivedAt: new Date(),
      deliveryAttempt: message.deliveryAttempt,
      enqueuedAt: message.metadata.pgmq?.enqueuedAt,
    };

    consumedMessages.unshift(consumed);
    if (consumedMessages.length > MAX_STORED_MESSAGES) {
      consumedMessages.pop();
    }

    consumerStats.consumedCount++;
    consumerStats.lastConsumedAt = new Date();

    console.log(`[Consumer] Received order ${message.body.orderId}`, {
      messageId: message.id,
      deliveryAttempt: message.deliveryAttempt,
    });

    await message.ack();
  });

  console.log(`[Consumer] Subscribed to queue: ${config.pgmq.queueName}`);
}
