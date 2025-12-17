/**
 * SQS consumer setup
 */

import { createSQSConsumer } from '@anyq/sqs';
import { config } from './config.js';
import type { Order, ConsumedMessage } from './types.js';

export const consumer = createSQSConsumer<Order>({
  queueUrl: config.sqs.queueUrl,
  sqs: {
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
  consumer: {
    maxNumberOfMessages: 10,
    waitTimeSeconds: 5,
    visibilityTimeout: 30,
    pollingInterval: 1000,
  },
});

export const consumedMessages: ConsumedMessage[] = [];
const MAX_STORED_MESSAGES = 100;

export const consumerStats = {
  consumedCount: 0,
  lastConsumedAt: null as Date | null,
};

export async function initConsumer(): Promise<void> {
  await consumer.connect();
  console.log(`[Consumer] Connected to SQS at ${config.sqs.endpoint}`);

  await consumer.subscribe(async (message) => {
    const sqsMetadata = message.metadata?.sqs as {
      receiptHandle?: string;
      approximateReceiveCount?: number;
    } | undefined;

    const consumed: ConsumedMessage = {
      id: message.id,
      body: message.body,
      receivedAt: new Date(),
      receiptHandle: sqsMetadata?.receiptHandle,
      approximateReceiveCount: sqsMetadata?.approximateReceiveCount,
    };

    consumedMessages.unshift(consumed);
    if (consumedMessages.length > MAX_STORED_MESSAGES) {
      consumedMessages.pop();
    }

    consumerStats.consumedCount++;
    consumerStats.lastConsumedAt = new Date();

    console.log(`[Consumer] Received order ${message.body.orderId}`, {
      messageId: message.id,
      deliveryAttempt: message.deliveryAttempt,
    });

    await message.ack();
  });

  console.log(`[Consumer] Subscribed to queue: ${config.sqs.queueUrl}`);
}
