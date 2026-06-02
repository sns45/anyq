# @anyq/nats

NATS JetStream adapter for **anyq** - lightweight persistent messaging.

## Installation

```bash
npm install @anyq/nats @anyq/core nats
```

## Usage

```typescript
import { NatsProducer, NatsConsumer } from '@anyq/nats';

// Create producer
const producer = new NatsProducer({
  servers: ['localhost:4222'],
  stream: 'my-stream',
  subject: 'orders.>'
});

// Create consumer
const consumer = new NatsConsumer({
  servers: ['localhost:4222'],
  stream: 'my-stream',
  subject: 'orders.>',
  durable: 'my-consumer'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  console.log('Subject:', message.metadata.subject);
  await message.ack();
});

// Publish messages
await producer.publish({
  orderId: '12345',
  status: 'created'
});

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface NatsConfig {
  servers: string[];         // NATS server addresses
  stream: string;            // JetStream stream name
  subject: string;           // Subject pattern (supports wildcards)
  durable?: string;          // Durable consumer name
  // Authentication
  user?: string;
  pass?: string;
  token?: string;
  // Consumer options
  ackPolicy?: 'explicit' | 'none' | 'all';
  deliverPolicy?: 'all' | 'last' | 'new';
  maxDeliver?: number;       // Max redelivery attempts
}
```

## Features

- JetStream persistence
- Subject wildcards (`*`, `>`)
- Durable consumers
- At-least-once / exactly-once delivery
- Work queues (load balancing)
- Message replay

## Retry strategies (0.3.0)

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `NATSConsumer.applyStrategy()` takes over per-message error handling; omit it and the legacy catch behaviour (log; broker redelivers based on `maxDeliver` / `ackWait`) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **true** |
| Native `park` | JetStream `nak(delayMs)` — message is re-delivered after `delayMs` without consuming an ack-wait |
| `deadLetterMessage` | default (`nack(false)`) |

> Behaviour change (0.3.0): `message.nack(false)` now calls `jsMsg.term()` (terminate without redelivery) instead of ignoring the parameter and calling `nak()`. Previously, dead-lettered messages would be redelivered by JetStream regardless. Code that relied on the old (incorrect) behaviour should pass `nack(true)` explicitly.

```typescript
import { retryThenDeadLetter } from '@anyq/core';

const consumer = new NATSConsumer({
  connection: { servers: 'nats://localhost:4222' },
  jetstream: { stream: 'ORDERS', subjects: ['orders'] },
  subject: 'orders',
  strategy: retryThenDeadLetter({ maxAttempts: 5 }),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

MIT
