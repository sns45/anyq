/**
 * Azure Service Bus Consumer Setup
 */

import { createServiceBusConsumer, type ServiceBusConsumer, type IMessage } from '@anyq/azure-servicebus';
import { config } from './config.js';

interface Order {
  orderId: string;
  product: string;
  quantity: number;
  price: number;
  timestamp: string;
}

export let consumer: ServiceBusConsumer<Order>;
export let consumedCount = 0;
const recentMessages: Array<{ order: Order; receivedAt: string; metadata: unknown }> = [];
const MAX_RECENT_MESSAGES = 100;

export async function initConsumer(): Promise<void> {
  consumer = createServiceBusConsumer<Order>({
    connection: {
      connectionString: config.servicebus.connectionString,
    },
    queue: {
      name: config.servicebus.queue,
    },
    receiver: {
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationMs: 300000,
    },
    maxConcurrentCalls: 10,
  });

  await consumer.connect();
  console.log(`[Consumer] Connected to Azure Service Bus`);

  // Subscribe to orders
  await consumer.subscribe(async (message: IMessage<Order>) => {
    consumedCount++;

    const order = message.body;
    console.log(`[Consumer] Received order ${order.orderId}`, {
      messageId: message.id,
      sequenceNumber: message.metadata?.azureServicebus?.sequenceNumber?.toString(),
      sessionId: message.metadata?.azureServicebus?.sessionId,
    });

    // Store for stats
    recentMessages.push({
      order,
      receivedAt: new Date().toISOString(),
      metadata: {
        ...message.metadata,
        // Convert BigInt to string for JSON serialization
        azureServicebus: message.metadata?.azureServicebus ? {
          ...message.metadata.azureServicebus,
          sequenceNumber: message.metadata.azureServicebus.sequenceNumber?.toString(),
        } : undefined,
      },
    });

    // Keep only recent messages
    if (recentMessages.length > MAX_RECENT_MESSAGES) {
      recentMessages.shift();
    }

    // Acknowledge the message
    await message.ack();
  });

  console.log(`[Consumer] Subscribed to queue: ${config.servicebus.queue}`);
}

export function getConsumedCount(): number {
  return consumedCount;
}

export function getRecentMessages() {
  return recentMessages;
}
