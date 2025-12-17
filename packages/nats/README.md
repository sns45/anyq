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

## License

MIT
