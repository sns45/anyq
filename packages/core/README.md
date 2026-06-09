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

## Retry Strategies (0.3.0)

Pluggable, per-message error handling for consumers. A `RetryStrategy` maps an `(error, message, attempt)` triple to a decision: `ack`, `retry`, `requeue`, `deadLetter`, `park`, or `fail`. The feature is **opt-in**: when no `strategy` is set on the queue config, every adapter keeps its existing catch-block behavior byte-for-byte.

```typescript
import {
  retryThenDeadLetter,
  logAndSkip,
  deadLetterImmediate,
  backpressurePause,
  custom,
} from '@anyq/core';

const consumer = new MemoryConsumer({
  driver: 'memory',
  queueName: 'orders',
  // Retry retryable errors with backoff; dead-letter after maxAttempts.
  strategy: retryThenDeadLetter({ maxAttempts: 5 }),
});
```

Built-in factories:

- `retryThenDeadLetter({ maxAttempts?, backoff?, isRetryable? })` -- retry transient infrastructure failures in-process, dead-letter the rest.
- `deadLetterImmediate()` -- poison messages; no retry.
- `logAndSkip()` / `logAndFail()` -- ack-and-drop or crash the consumer loop.
- `backpressurePause({ pauseMs?, isRateLimited? })` -- on rate/quota errors, pause the consumer and resume after a delay.
- `custom(name, fn)` -- wrap any `(ctx) => RetryDecision` function.

Adapters that natively support delayed redelivery (memory, sqs, nats) honor the `park` action via their broker primitives (setTimeout re-enqueue, SQS `DelaySeconds`, NATS `nak(delay)`). On adapters without native delay, `park` downgrades to in-process retry with a warning.

> Note: future minor versions may add new `RetryDecision` variants. Custom strategies that switch on `decision.action` should include a `default` branch.

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
