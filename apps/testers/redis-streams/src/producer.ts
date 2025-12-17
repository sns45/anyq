/**
 * @fileoverview Producer setup for Redis Streams tester
 */

import { RedisStreamsProducer } from '@anyq/redis-streams';
import { producerConfig } from './config.js';
import type { OrderMessage } from './types.js';

let producer: RedisStreamsProducer<OrderMessage> | null = null;
let messagesPublished = 0;

export async function initProducer(): Promise<RedisStreamsProducer<OrderMessage>> {
  if (producer) {
    return producer;
  }

  producer = new RedisStreamsProducer<OrderMessage>(producerConfig);
  await producer.connect();
  console.log('✅ Producer connected to Redis');
  return producer;
}

export function getProducer(): RedisStreamsProducer<OrderMessage> | null {
  return producer;
}

export async function publishMessage(order: OrderMessage): Promise<string> {
  if (!producer) {
    throw new Error('Producer not initialized');
  }

  const messageId = await producer.publish(order, {
    key: order.customerId,
    headers: {
      'x-order-type': 'standard',
      'x-timestamp': new Date().toISOString(),
    },
  });

  messagesPublished++;
  return messageId;
}

export async function publishBatch(orders: OrderMessage[]): Promise<string[]> {
  if (!producer) {
    throw new Error('Producer not initialized');
  }

  const messages = orders.map((order) => ({
    body: order,
    options: {
      key: order.customerId,
      headers: {
        'x-order-type': 'standard',
        'x-timestamp': new Date().toISOString(),
      },
    },
  }));

  const messageIds = await producer.publishBatch(messages);
  messagesPublished += messageIds.length;
  return messageIds;
}

export function getProducerStats() {
  return {
    connected: producer?.isConnected() ?? false,
    messagesPublished,
  };
}

export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    console.log('Producer disconnected');
  }
}
