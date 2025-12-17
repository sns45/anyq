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

## License

MIT
