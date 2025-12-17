/**
 * NATS Producer Setup
 */

import { createNATSProducer, type NATSProducer } from '@anyq/nats';
import { config } from './config.js';

export let producer: NATSProducer<unknown>;
export let publishedCount = 0;

export async function initProducer(): Promise<void> {
  producer = createNATSProducer({
    connection: {
      servers: config.nats.servers,
      name: 'anyq-nats-producer',
    },
    jetstream: {
      stream: config.nats.stream,
      subjects: [`${config.nats.subject.split('.')[0]}.*`],
      storage: 'memory',
      retention: 'workqueue',
    },
    subject: config.nats.subject,
  });

  await producer.connect();
  console.log(`[Producer] Connected to NATS at ${config.nats.servers}`);
  console.log(`[Producer] Stream: ${config.nats.stream}, Subject: ${config.nats.subject}`);
}

export function incrementPublishedCount(): void {
  publishedCount++;
}

export function getPublishedCount(): number {
  return publishedCount;
}
