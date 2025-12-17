# @anyq/core

Core interfaces and utilities for **anyq** - a Universal Message Queue Library.

## Installation

```bash
npm install @anyq/core
```

## Overview

This package provides the foundational types, interfaces, and utilities used by all anyq adapters:

- **IProducer** - Interface for publishing messages
- **IConsumer** - Interface for consuming messages
- **IMessage** - Standard message format across all adapters
- **Middleware** - Circuit breaker, retry with exponential backoff
- **Serialization** - JSON serializer with schema support

## Usage

```typescript
import {
  IProducer,
  IConsumer,
  IMessage,
  CircuitBreaker,
  RetryWithBackoff,
  JsonSerializer
} from '@anyq/core';
```

## Interfaces

### IProducer

```typescript
interface IProducer<T = unknown> {
  publish(message: T, options?: PublishOptions): Promise<PublishResult>;
  publishBatch(messages: T[], options?: PublishOptions): Promise<PublishResult[]>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
```

### IConsumer

```typescript
interface IConsumer<T = unknown> {
  subscribe(handler: MessageHandler<T>, options?: SubscribeOptions): Promise<void>;
  unsubscribe(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
```

### IMessage

```typescript
interface IMessage<T = unknown> {
  id: string;
  data: T;
  timestamp: Date;
  headers?: Record<string, string>;
  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
  extend?(seconds: number): Promise<void>;
}
```

## Adapters

Use @anyq/core with these adapters:

- [@anyq/memory](https://www.npmjs.com/package/@anyq/memory) - In-memory (testing)
- [@anyq/redis-streams](https://www.npmjs.com/package/@anyq/redis-streams) - Redis Streams
- [@anyq/rabbitmq](https://www.npmjs.com/package/@anyq/rabbitmq) - RabbitMQ
- [@anyq/sqs](https://www.npmjs.com/package/@anyq/sqs) - AWS SQS
- [@anyq/sns](https://www.npmjs.com/package/@anyq/sns) - AWS SNS
- [@anyq/kafka](https://www.npmjs.com/package/@anyq/kafka) - Apache Kafka
- [@anyq/nats](https://www.npmjs.com/package/@anyq/nats) - NATS JetStream
- [@anyq/google-pubsub](https://www.npmjs.com/package/@anyq/google-pubsub) - Google Pub/Sub
- [@anyq/azure-servicebus](https://www.npmjs.com/package/@anyq/azure-servicebus) - Azure Service Bus

## License

MIT
