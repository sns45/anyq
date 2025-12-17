# @anyq/sqs

AWS SQS adapter for **anyq** - fully managed cloud queuing.

## Installation

```bash
npm install @anyq/sqs @anyq/core @aws-sdk/client-sqs
```

## Usage

```typescript
import { SQSProducer, SQSConsumer } from '@anyq/sqs';

// Create producer
const producer = new SQSProducer({
  region: 'us-east-1',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue'
});

// Create consumer
const consumer = new SQSConsumer({
  region: 'us-east-1',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  await message.ack();
});

// Publish messages
await producer.publish({
  event: 'payment.processed',
  amount: 99.99
});

// Batch publish
await producer.publishBatch([
  { item: 1 },
  { item: 2 }
]);

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface SQSConfig {
  region: string;              // AWS region
  queueUrl: string;            // Full SQS queue URL
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  visibilityTimeout?: number;  // Seconds (default: 30)
  waitTimeSeconds?: number;    // Long polling (default: 20)
  maxMessages?: number;        // Messages per poll (1-10)
  // FIFO queue options
  messageGroupId?: string;
  deduplicationId?: string;
}
```

## Features

- Standard and FIFO queues
- Long polling
- Batch operations (up to 10 messages)
- Visibility timeout management
- Dead letter queues
- Message deduplication (FIFO)

## License

MIT
