/**
 * RabbitMQ Consumer Setup
 */

import { createRabbitMQConsumer, type RabbitMQConsumer, type IMessage } from '@anyq/rabbitmq';
import { config } from './config.js';

interface Order {
  orderId: string;
  product: string;
  quantity: number;
  price: number;
  timestamp: string;
}

export let consumer: RabbitMQConsumer<Order>;
export let consumedCount = 0;
const recentMessages: Array<{ order: Order; receivedAt: string; metadata: unknown }> = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<void> {
  consumer = createRabbitMQConsumer<Order>({
    connection: {
      url: config.rabbitmq.url,
    },
    queue: {
      name: config.rabbitmq.queue,
      durable: true,
    },
    exchange: {
      name: config.rabbitmq.exchange,
      type: 'direct',
      durable: true,
    },
    bindingKey: config.rabbitmq.routingKey,
    consumer: {
      prefetch: 10,
      noAck: false,
    },
  });

  await consumer.connect();
  console.log(`[Consumer] Connected to RabbitMQ at ${config.rabbitmq.url}`);

  // Subscribe to orders
  await consumer.subscribe(async (message: IMessage<Order>) => {
    consumedCount++;

    const order = message.body;
    console.log(`[Consumer] Received order ${order.orderId}`, {
      messageId: message.id,
      exchange: message.metadata?.rabbitmq?.exchange,
      routingKey: message.metadata?.rabbitmq?.routingKey,
      redelivered: message.metadata?.rabbitmq?.redelivered,
    });

    // Store for stats
    recentMessages.push({
      order,
      receivedAt: new Date().toISOString(),
      metadata: message.metadata,
    });

    // Keep only recent messages
    if (recentMessages.length > MAX_RECENT_MESSAGES) {
      recentMessages.shift();
    }

    // Acknowledge the message
    await message.ack();
  });

  console.log(`[Consumer] Subscribed to queue: ${config.rabbitmq.queue}`);
}

export function getConsumedCount(): number {
  return consumedCount;
}

export function getRecentMessages() {
  return recentMessages;
}
