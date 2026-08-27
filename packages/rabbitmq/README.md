# @anyq/rabbitmq

RabbitMQ adapter for **anyq** - robust AMQP messaging.

## Installation

```bash
npm install @anyq/rabbitmq @anyq/core amqplib
```

## Usage

```typescript
import { RabbitMQProducer, RabbitMQConsumer } from '@anyq/rabbitmq';

// Create producer
const producer = new RabbitMQProducer({
  connection: { url: 'amqp://localhost:5672' },
  exchange: 'my-exchange',
  routingKey: 'my-routing-key'
});

// Create consumer
const consumer = new RabbitMQConsumer({
  connection: { url: 'amqp://localhost:5672' },
  queue: 'my-queue',
  exchange: 'my-exchange',
  routingKey: 'my-routing-key'
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
  event: 'order.created',
  orderId: '12345'
});

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface RabbitMQConfig {
  connection: {
    url: string;          // amqp://user:pass@host:port/vhost
  };
  exchange?: string;      // Exchange name
  exchangeType?: 'direct' | 'topic' | 'fanout' | 'headers';
  queue?: string;         // Queue name
  routingKey?: string;    // Routing key
  prefetch?: number;      // Prefetch count (QoS)
  durable?: boolean;      // Durable queue/exchange
}
```

## Features

- Exchange types: direct, topic, fanout, headers
- Durable queues and exchanges
- Message acknowledgment
- Prefetch/QoS control
- Automatic reconnection
- Dead letter queues

## Retry strategies (0.3.0)

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `RabbitMQConsumer.applyStrategy()` takes over per-message error handling; omit it and the legacy catch behaviour (log only; message stays unacked) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **false** (this release) |
| `park` | downgrades to in-process retry with a `warn` log, capped by `maxAttempts`. The broker-native TTL+DLX implementation is a follow-up |
| `deadLetterMessage` | default (`nack(false)` → reject without requeue). Combine with a per-queue `x-dead-letter-exchange` for routing |

> Behaviour change (0.3.0): `message.nack(false)` now actually rejects without requeue. Prior to 0.3.0, `onNack` ignored its `requeue` parameter and always requeued — dead-lettered messages would redeliver indefinitely. Code that relied on the old behaviour should pass `nack(true)` explicitly.

```typescript
import { retryThenDeadLetter } from '@anyq/core';

const consumer = new RabbitMQConsumer({
  connection: { url: 'amqp://localhost:5672' },
  queue: { name: 'orders', durable: true },
  exchange: { name: 'orders-ex', type: 'direct', durable: true },
  bindingKey: 'orders',
  strategy: retryThenDeadLetter({ maxAttempts: 5 }),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

Apache License 2.0. See [LICENSE](https://github.com/sns45/anyq/blob/main/LICENSE).
