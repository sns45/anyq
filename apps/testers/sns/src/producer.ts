/**
 * SNS producer setup
 */

import { createSNSProducer } from '@anyq/sns';
import { config } from './config.js';
import type { Order } from './types.js';

export const producer = createSNSProducer<Order>({
  topicArn: config.sns.topicArn,
  sns: {
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export const producerStats = {
  publishedCount: 0,
  lastPublishedAt: null as Date | null,
};

export async function initProducer(): Promise<void> {
  await producer.connect();
  console.log(`[Producer] Connected to SNS at ${config.aws.endpoint}`);
  console.log(`[Producer] Topic ARN: ${config.sns.topicArn}`);
}
