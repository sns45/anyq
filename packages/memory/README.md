# @anyq/memory

In-memory queue adapter for **anyq** - perfect for testing and development.

## Installation

```bash
npm install @anyq/memory @anyq/core
```

## Usage

```typescript
import { MemoryProducer, MemoryConsumer } from '@anyq/memory';

// Create producer
const producer = new MemoryProducer({
  queue: 'my-queue'
});

// Create consumer
const consumer = new MemoryConsumer({
  queue: 'my-queue'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  await message.ack();
});

// Publish messages
await producer.publish({ hello: 'world' });
await producer.publishBatch([
  { order: 1 },
  { order: 2 }
]);

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface MemoryQueueConfig {
  queue: string;           // Queue name
  maxSize?: number;        // Max messages in queue (default: unlimited)
  deliveryDelay?: number;  // Delay before message delivery (ms)
}
```

## Features

- No external dependencies
- Perfect for unit tests
- Supports ack/nack
- Message persistence during session
- Batch publishing

## License

MIT
