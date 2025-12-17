/**
 * Google Pub/Sub Producer Setup
 */

import { createPubSubProducer, type PubSubProducer } from '@anyq/google-pubsub';
import { config } from './config.js';

export let producer: PubSubProducer<unknown>;
export let publishedCount = 0;

export async function initProducer(): Promise<void> {
  producer = createPubSubProducer({
    connection: {
      projectId: config.pubsub.projectId,
      apiEndpoint: config.pubsub.apiEndpoint,
      emulatorMode: true,
    },
    topic: {
      name: config.pubsub.topicName,
      autoCreate: true,
    },
  });

  await producer.connect();
  console.log(`[Producer] Connected to Pub/Sub emulator at ${config.pubsub.apiEndpoint}`);
  console.log(`[Producer] Topic: ${config.pubsub.topicName}`);
}

export function incrementPublishedCount(): void {
  publishedCount++;
}

export function getPublishedCount(): number {
  return publishedCount;
}
