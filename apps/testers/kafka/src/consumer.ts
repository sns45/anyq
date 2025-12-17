/**
 * Kafka consumer setup
 */

import { createKafkaConsumer } from '@anyq/kafka';
import { config } from './config.js';
import type { Order, ConsumedMessage } from './types.js';

export const consumer = createKafkaConsumer<Order>({
  topic: config.kafka.topic,
  kafka: {
    brokers: config.kafka.brokers,
    clientId: `${config.kafka.clientId}-consumer`,
  },
  consumerGroup: {
    groupId: config.kafka.groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    autoCommit: true,
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
  console.log(`[Consumer] Connected to Kafka at ${config.kafka.brokers.join(', ')}`);

  await consumer.subscribe(async (message) => {
    const kafkaMetadata = message.metadata?.kafka as {
      partition?: number;
      offset?: string;
      key?: string;
    } | undefined;

    const consumed: ConsumedMessage = {
      id: message.id,
      body: message.body,
      receivedAt: new Date(),
      partition: kafkaMetadata?.partition,
      offset: kafkaMetadata?.offset,
      key: kafkaMetadata?.key,
    };

    consumedMessages.unshift(consumed);
    if (consumedMessages.length > MAX_STORED_MESSAGES) {
      consumedMessages.pop();
    }

    consumerStats.consumedCount++;
    consumerStats.lastConsumedAt = new Date();

    console.log(`[Consumer] Received order ${message.body.orderId}`, {
      messageId: message.id,
      partition: kafkaMetadata?.partition,
      offset: kafkaMetadata?.offset,
    });

    await message.ack();
  });

  console.log(`[Consumer] Subscribed to topic: ${config.kafka.topic}`);
}
