/**
 * NATS Consumer Setup
 */

import { createNATSConsumer, type NATSConsumer, type IMessage } from '@anyq/nats';
import { config } from './config.js';

interface Order {
  orderId: string;
  product: string;
  quantity: number;
  price: number;
  timestamp: string;
}

export let consumer: NATSConsumer<Order>;
export let consumedCount = 0;
const recentMessages: Array<{ order: Order; receivedAt: string; metadata: unknown }> = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<void> {
  consumer = createNATSConsumer<Order>({
    connection: {
      servers: config.nats.servers,
      name: 'anyq-nats-consumer',
    },
    jetstream: {
      stream: config.nats.stream,
      subjects: [`${config.nats.subject.split('.')[0]}.*`],
      storage: 'memory',
      retention: 'workqueue',
    },
    subject: config.nats.subject,
    consumer: {
      durableName: 'orders-processor',
      deliverPolicy: 'all',
      maxDeliver: 3,
      ackWait: 30 * 1e9, // 30 seconds
    },
  });

  await consumer.connect();
  console.log(`[Consumer] Connected to NATS at ${config.nats.servers}`);

  // Subscribe to orders
  await consumer.subscribe(async (message: IMessage<Order>) => {
    consumedCount++;

    const order = message.body;
    console.log(`[Consumer] Received order ${order.orderId} via JetStream`, {
      messageId: message.id,
      sequence: message.metadata?.nats?.sequence,
      redelivered: message.metadata?.nats?.redelivered,
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

  console.log(`[Consumer] Subscribed to subject: ${config.nats.subject}`);
}

export function getConsumedCount(): number {
  return consumedCount;
}

export function getRecentMessages() {
  return recentMessages;
}
