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

## Retry strategies (0.3.0)

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `SQSConsumer.applyStrategy()` takes over per-message error handling; omit it and the legacy catch behaviour (log + emit `error`; visibility timeout governs redelivery) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **true** |
| Native `park` | re-publishes the message with `SendMessage` `DelaySeconds` (capped at 900s) and deletes the in-flight copy |
| `deadLetterMessage` | default (`nack(false)` → `DeleteMessage`). Configure an SQS redrive policy on the queue if you want messages routed to a dedicated DLQ |

```typescript
import { backpressurePause } from '@anyq/core';

const consumer = new SQSConsumer({
  driver: 'sqs',
  queueUrl: '...',
  sqs: { region: 'us-east-1' },
  strategy: backpressurePause({ pauseMs: 30_000 }),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

Apache License 2.0. See [LICENSE](https://github.com/sns45/anyq/blob/main/LICENSE).
