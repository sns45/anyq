# @anyq/sns

AWS SNS adapter for **anyq** - pub/sub fan-out messaging.

## Installation

```bash
npm install @anyq/sns @anyq/core @aws-sdk/client-sns
```

## Usage

```typescript
import { SNSProducer } from '@anyq/sns';

// Create producer
const producer = new SNSProducer({
  region: 'us-east-1',
  topicArn: 'arn:aws:sns:us-east-1:123456789:my-topic'
});

await producer.connect();

// Publish messages
await producer.publish({
  event: 'user.signup',
  userId: 'user-123'
});

// Publish with attributes
await producer.publish(
  { event: 'order.created' },
  {
    attributes: {
      eventType: 'order',
      priority: 'high'
    }
  }
);

// Batch publish
await producer.publishBatch([
  { notification: 'first' },
  { notification: 'second' }
]);

await producer.disconnect();
```

## Configuration

```typescript
interface SNSConfig {
  region: string;            // AWS region
  topicArn: string;          // SNS topic ARN
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  // FIFO topic options
  messageGroupId?: string;
  deduplicationId?: string;
}
```

## Features

- Fan-out to multiple subscribers
- Message filtering by attributes
- Standard and FIFO topics
- Batch publishing
- Cross-region publishing

## Note

SNS is a producer-only service. Messages are delivered to subscribers (SQS, Lambda, HTTP, etc.) configured in the AWS Console.

## Retry strategies (0.3.0)

Pluggable retry strategies from `@anyq/core` are a **consumer-side** feature. SNS has no consumer, so the `strategy` config field has no effect here. If you need per-error handling for SNS-delivered messages, apply a strategy on the downstream `@anyq/sqs` consumer or other subscribing service.

## License

MIT
