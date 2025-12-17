/**
 * @fileoverview Consumer setup for memory tester
 */

import { MemoryConsumer, getQueueStats } from '@anyq/memory';
import { queueConfig, config } from './config.js';
import type { OrderMessage, ConsumedMessage } from './types.js';

let consumer: MemoryConsumer<OrderMessage> | null = null;
let messagesConsumed = 0;
let lastMessageTime: Date | null = null;
const recentMessages: ConsumedMessage[] = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<MemoryConsumer<OrderMessage>> {
  if (consumer) {
    return consumer;
  }

  consumer = new MemoryConsumer<OrderMessage>(queueConfig);
  await consumer.connect();

  // Subscribe to messages
  await consumer.subscribe(
    async (message) => {
      const receivedAt = new Date().toISOString();

      console.log(`📥 Received order: ${message.body.orderId}`, {
        customerId: message.body.customerId,
        total: message.body.total,
        items: message.body.items.length,
      });

      // Simulate some processing time
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Store in recent messages
      const consumed: ConsumedMessage = {
        id: message.id,
        body: message.body,
        receivedAt,
        processedAt: new Date().toISOString(),
      };

      recentMessages.unshift(consumed);
      if (recentMessages.length > MAX_RECENT_MESSAGES) {
        recentMessages.pop();
      }

      messagesConsumed++;
      lastMessageTime = new Date();

      // Acknowledge the message
      await message.ack();
    },
    { autoAck: false }
  );

  console.log('✅ Consumer connected and subscribed');
  return consumer;
}

export function getConsumer(): MemoryConsumer<OrderMessage> | null {
  return consumer;
}

export function getConsumerStats() {
  const qStats = getQueueStats();
  const queueStat = qStats[config.queueName] ?? { size: 0, processing: 0 };

  return {
    connected: consumer?.isConnected() ?? false,
    messagesConsumed,
    lastMessageTime: lastMessageTime?.toISOString() ?? null,
    queue: {
      size: queueStat.size,
      processing: queueStat.processing,
    },
  };
}

export function getRecentMessages(): ConsumedMessage[] {
  return recentMessages;
}

export async function disconnectConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
    console.log('Consumer disconnected');
  }
}
