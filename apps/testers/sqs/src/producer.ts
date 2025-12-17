/**
 * SQS producer setup
 */

import { createSQSProducer } from '@anyq/sqs';
import { config } from './config.js';
import type { Order } from './types.js';

export const producer = createSQSProducer<Order>({
  queueUrl: config.sqs.queueUrl,
  sqs: {
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
});

export const producerStats = {
  publishedCount: 0,
  lastPublishedAt: null as Date | null,
};

export async function initProducer(): Promise<void> {
  await producer.connect();
  console.log(`[Producer] Connected to SQS at ${config.sqs.endpoint}`);
}
