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

## Retry strategies (0.3.0)

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `RedisStreamsConsumer.applyStrategy()` takes over per-message error handling; omit it and the legacy catch behaviour (log; message becomes pending and is re-claimed by `XAUTOCLAIM`) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **false** (this release) |
| `park` | downgrades to in-process retry with a `warn` log, capped by `maxAttempts`. The parking sorted-set implementation is a follow-up |
| `deadLetterMessage` | default (`nack(false)` → `XACK`, removing the entry from the pending list). For a real DLQ, publish to a `<stream>.dlq` from your handler |

```typescript
import { retryThenDeadLetter } from '@anyq/core';

const consumer = new RedisStreamsConsumer({
  driver: 'redis-streams',
  streamName: 'orders',
  consumerGroup: { groupName: 'order-processors', consumerName: 'consumer-1' },
  redis: { host: 'localhost', port: 6379 },
  strategy: retryThenDeadLetter({ maxAttempts: 5 }),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

MIT
