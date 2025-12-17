/**
 * SQS consumer for SNS messages
 * SNS doesn't have direct consumers - we use SQS subscription
 */

import { createSQSConsumer } from '@anyq/sqs';
import { config } from './config.js';
import type { Order, ConsumedMessage } from './types.js';

// SNS wraps messages, so we need to unwrap
interface SNSEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
}

export const consumer = createSQSConsumer<SNSEnvelope | Order>({
  queueUrl: config.sqs.queueUrl,
  sqs: {
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
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

function isSNSEnvelope(body: unknown): body is SNSEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'Type' in body &&
    'Message' in body &&
    'TopicArn' in body
  );
}

export async function initConsumer(): Promise<void> {
  await consumer.connect();
  console.log(`[Consumer] Connected to SQS at ${config.aws.endpoint}`);

  await consumer.subscribe(async (message) => {
    let orderBody: Order;

    // Check if this is an SNS envelope
    if (isSNSEnvelope(message.body)) {
      // Parse the inner message
      orderBody = JSON.parse(message.body.Message) as Order;
    } else {
      orderBody = message.body as Order;
    }

    const consumed: ConsumedMessage = {
      id: message.id,
      body: orderBody,
      receivedAt: new Date(),
      source: 'sns-via-sqs',
    };

    consumedMessages.unshift(consumed);
    if (consumedMessages.length > MAX_STORED_MESSAGES) {
      consumedMessages.pop();
    }

    consumerStats.consumedCount++;
    consumerStats.lastConsumedAt = new Date();

    console.log(`[Consumer] Received order ${orderBody.orderId} via SNS->SQS`, {
      messageId: message.id,
    });

    await message.ack();
  });

  console.log(`[Consumer] Subscribed to queue: ${config.sqs.queueUrl}`);
}
