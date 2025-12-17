/**
 * Google Pub/Sub Consumer Setup
 */

import { createPubSubConsumer, type PubSubConsumer, type IMessage } from '@anyq/google-pubsub';
import { config } from './config.js';

interface Order {
  orderId: string;
  product: string;
  quantity: number;
  price: number;
  timestamp: string;
}

export let consumer: PubSubConsumer<Order>;
export let consumedCount = 0;
const recentMessages: Array<{ order: Order; receivedAt: string; metadata: unknown }> = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<void> {
  consumer = createPubSubConsumer<Order>({
    connection: {
      projectId: config.pubsub.projectId,
      apiEndpoint: config.pubsub.apiEndpoint,
      emulatorMode: true,
    },
    subscription: {
      name: config.pubsub.subscriptionName,
      autoCreate: true,
      ackDeadlineSeconds: 30,
    },
    topicName: config.pubsub.topicName,
  });

  await consumer.connect();
  console.log(`[Consumer] Connected to Pub/Sub emulator at ${config.pubsub.apiEndpoint}`);

  // Subscribe to orders
  await consumer.subscribe(async (message: IMessage<Order>) => {
    consumedCount++;

    const order = message.body;
    console.log(`[Consumer] Received order ${order.orderId} via Pub/Sub`, {
      messageId: message.id,
      publishTime: message.metadata?.googlePubsub?.publishTime,
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

  console.log(`[Consumer] Subscribed to: ${config.pubsub.subscriptionName}`);
}

export function getConsumedCount(): number {
  return consumedCount;
}

export function getRecentMessages() {
  return recentMessages;
}
