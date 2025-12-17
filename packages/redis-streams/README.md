# @anyq/redis-streams

Redis Streams adapter for **anyq** - lightweight, persistent streaming.

## Installation

```bash
npm install @anyq/redis-streams @anyq/core ioredis
```

## Usage

```typescript
import { RedisStreamsProducer, RedisStreamsConsumer } from '@anyq/redis-streams';

// Create producer
const producer = new RedisStreamsProducer({
  connection: { host: 'localhost', port: 6379 },
  stream: 'my-stream'
});

// Create consumer
const consumer = new RedisStreamsConsumer({
  connection: { host: 'localhost', port: 6379 },
  stream: 'my-stream',
  group: 'my-consumer-group',
  consumer: 'consumer-1'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  await message.ack();
});

// Publish messages
await producer.publish({ event: 'user.created', userId: '123' });

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface RedisStreamsConfig {
  connection: {
    host: string;
    port: number;
    password?: string;
    tls?: boolean;
  };
  stream: string;           // Stream name
  group?: string;           // Consumer group
  consumer?: string;        // Consumer name within group
  maxLen?: number;          // Max stream length (MAXLEN)
  blockTime?: number;       // Block time for XREADGROUP (ms)
}
```

## Features

- Consumer groups for load balancing
- Message persistence
- Auto-claim for stuck messages
- Exactly-once delivery semantics
- Stream trimming (MAXLEN)

## License

MIT
