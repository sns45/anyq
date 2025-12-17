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

## License

MIT
