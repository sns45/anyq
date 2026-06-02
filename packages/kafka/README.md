# @anyq/kafka

Apache Kafka adapter for **anyq** - high-throughput distributed streaming.

## Installation

```bash
npm install @anyq/kafka @anyq/core kafkajs
```

## Usage

```typescript
import { KafkaProducer, KafkaConsumer } from '@anyq/kafka';

// Create producer
const producer = new KafkaProducer({
  brokers: ['localhost:9092'],
  topic: 'my-topic',
  clientId: 'my-app'
});

// Create consumer
const consumer = new KafkaConsumer({
  brokers: ['localhost:9092'],
  topic: 'my-topic',
  groupId: 'my-consumer-group',
  clientId: 'my-app'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  console.log('Partition:', message.metadata.partition);
  console.log('Offset:', message.metadata.offset);
  await message.ack();
});

// Publish messages
await producer.publish({
  event: 'click',
  userId: 'user-123'
});

// Publish with key (for partitioning)
await producer.publish(
  { event: 'purchase' },
  { key: 'user-123' }  // Same key = same partition
);

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface KafkaConfig {
  brokers: string[];         // Kafka broker addresses
  topic: string;             // Topic name
  clientId: string;          // Client identifier
  groupId?: string;          // Consumer group (consumer only)
  // SSL/SASL
  ssl?: boolean;
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
  // Producer options
  acks?: -1 | 0 | 1;         // Acknowledgment level
  compression?: 'gzip' | 'snappy' | 'lz4';
  // Consumer options
  fromBeginning?: boolean;   // Start from earliest offset
  autoCommit?: boolean;      // Auto-commit offsets
}
```

## Features

- Consumer groups for load balancing
- Partition-based ordering (by key)
- Compression (gzip, snappy, lz4)
- SSL/SASL authentication
- Idempotent producer
- Manual offset management

## Retry strategies (0.3.0)

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `KafkaConsumer.applyStrategy()` takes over per-message error handling; omit it and the legacy catch behaviour (log + emit `error`; with `autoCommit` on, effectively skips the message) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **false** (this release) |
| `park` | downgrades to in-process retry with a `warn` log, capped by `maxAttempts`. The tiered retry-topics implementation is a follow-up |
| `deadLetterMessage` | default (`nack(false)` is a no-op for kafka; with `autoCommit` the offset advances past the message). Publish to a `<topic>.dlq` from your handler if you need a real DLQ |
| Batch (`subscribeBatch`) | Kafka commits offsets per-batch, so handler failure is **all-or-nothing**: the strategy is applied to the first message as the batch representative |

```typescript
import { logAndSkip } from '@anyq/core';

const consumer = new KafkaConsumer({
  driver: 'kafka',
  kafka: { brokers: ['localhost:9092'] },
  topic: 'orders',
  consumerGroup: { groupId: 'order-processors' },
  strategy: logAndSkip(),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

MIT
