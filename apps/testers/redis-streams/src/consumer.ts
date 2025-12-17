/**
 * @fileoverview Consumer setup for Redis Streams tester
 */

import { RedisStreamsConsumer } from '@anyq/redis-streams';
import { consumerConfig, config } from './config.js';
import type { OrderMessage, ConsumedMessage } from './types.js';

let consumer: RedisStreamsConsumer<OrderMessage> | null = null;
let messagesConsumed = 0;
let lastMessageTime: Date | null = null;
const recentMessages: ConsumedMessage[] = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<RedisStreamsConsumer<OrderMessage>> {
  if (consumer) {
    return consumer;
  }

  consumer = new RedisStreamsConsumer<OrderMessage>(consumerConfig);
  await consumer.connect();

  // Subscribe to messages
  await consumer.subscribe(
    async (message) => {
      const receivedAt = new Date().toISOString();

      console.log(`📥 Received order: ${message.body.orderId}`, {
        customerId: message.body.customerId,
        total: message.body.total,
        items: message.body.items.length,
        streamId: message.id,
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

export function getConsumer(): RedisStreamsConsumer<OrderMessage> | null {
  return consumer;
}

export function getConsumerStats() {
  return {
    connected: consumer?.isConnected() ?? false,
    messagesConsumed,
    lastMessageTime: lastMessageTime?.toISOString() ?? null,
    paused: consumer?.isPaused() ?? false,
    redis: {
      host: `${config.redis.host}:${config.redis.port}`,
      stream: config.streamName,
      consumerGroup: config.consumerGroup,
    },
  };
}

export function getRecentMessages(): ConsumedMessage[] {
  return recentMessages;
}

export async function pauseConsumer(): Promise<void> {
  if (consumer) {
    await consumer.pause();
    console.log('Consumer paused');
  }
}

export async function resumeConsumer(): Promise<void> {
  if (consumer) {
    await consumer.resume();
    console.log('Consumer resumed');
  }
}

export async function disconnectConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
    console.log('Consumer disconnected');
  }
}
