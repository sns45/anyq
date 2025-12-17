# @anyq/google-pubsub

Google Cloud Pub/Sub adapter for **anyq** - global serverless messaging.

## Installation

```bash
npm install @anyq/google-pubsub @anyq/core @google-cloud/pubsub
```

## Usage

```typescript
import { GooglePubSubProducer, GooglePubSubConsumer } from '@anyq/google-pubsub';

// Create producer
const producer = new GooglePubSubProducer({
  projectId: 'my-gcp-project',
  topic: 'my-topic'
});

// Create consumer
const consumer = new GooglePubSubConsumer({
  projectId: 'my-gcp-project',
  subscription: 'my-subscription'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  console.log('Attributes:', message.headers);
  await message.ack();
});

// Publish messages
await producer.publish({
  event: 'file.uploaded',
  filename: 'document.pdf'
});

// Publish with ordering key
await producer.publish(
  { event: 'state.change' },
  { orderingKey: 'entity-123' }
);

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface GooglePubSubConfig {
  projectId: string;          // GCP project ID
  topic?: string;             // Topic name (producer)
  subscription?: string;      // Subscription name (consumer)
  // Authentication (optional if using ADC)
  keyFilename?: string;       // Path to service account key
  credentials?: object;       // Inline credentials
  // Consumer options
  maxMessages?: number;       // Max concurrent messages
  ackDeadline?: number;       // Ack deadline (seconds)
  // Producer options
  enableOrdering?: boolean;   // Enable message ordering
  batching?: {
    maxMessages: number;
    maxMilliseconds: number;
  };
}
```

## Features

- Global message delivery
- Message ordering (by key)
- Exactly-once delivery
- Dead letter topics
- Message filtering
- Automatic batching

## Authentication

Uses Google Cloud Application Default Credentials (ADC):
- Set `GOOGLE_APPLICATION_CREDENTIALS` env var
- Or provide `keyFilename` in config
- Or use GCE/GKE default service account

## License

MIT
