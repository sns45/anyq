/**
 * Azure Service Bus Producer Setup
 */

import { createServiceBusProducer, type ServiceBusProducer } from '@anyq/azure-servicebus';
import { config } from './config.js';

export let producer: ServiceBusProducer<unknown>;
export let publishedCount = 0;

export async function initProducer(): Promise<void> {
  producer = createServiceBusProducer({
    connection: {
      connectionString: config.servicebus.connectionString,
    },
    queue: {
      name: config.servicebus.queue,
    },
  });

  await producer.connect();
  console.log(`[Producer] Connected to Azure Service Bus`);
  console.log(`[Producer] Queue: ${config.servicebus.queue}`);
}

export function incrementPublishedCount(): void {
  publishedCount++;
}

export function getPublishedCount(): number {
  return publishedCount;
}
