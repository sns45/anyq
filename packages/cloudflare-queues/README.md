# @anyq/cloudflare-queues

Cloudflare Queues adapter for **anyq** - push-based queuing for Cloudflare Workers.

Cloudflare Queues works differently from broker-polling adapters like SQS or
RabbitMQ: a producer publishes through a `Queue` binding declared in
`wrangler.toml`/`wrangler.jsonc` (`env.MY_QUEUE.send(...)`), and the platform
delivers batches directly to a Worker's `queue(batch, env, ctx)` export.
There is no long-poll pull loop, so the consumer in this package registers a
handler and exposes `processBatch()` for your Worker to call.

## Installation

```bash
npm install @anyq/cloudflare-queues @anyq/core
```

Add `@cloudflare/workers-types` to your Worker project's devDependencies if
you don't already have it (used for the `Queue`/`MessageBatch`/`Message`
types).

## Usage

```typescript
import { CloudflareQueuesProducer, CloudflareQueuesConsumer } from '@anyq/cloudflare-queues';
import type { MessageBatch, Queue } from '@cloudflare/workers-types';

interface Env {
  MY_QUEUE: Queue;
}

export default {
  async fetch(request: Request, env: Env) {
    const producer = new CloudflareQueuesProducer({
      driver: 'cloudflare-queues',
      queue: env.MY_QUEUE,
    });

    await producer.connect();
    await producer.publish({ orderId: '123' });
    await producer.disconnect();

    return new Response('ok');
  },

  async queue(batch: MessageBatch, env: Env) {
    const consumer = new CloudflareQueuesConsumer({ driver: 'cloudflare-queues' });
    await consumer.connect();

    await consumer.subscribe(async (message) => {
      console.log('Received:', message.body);
      await message.ack();
    });

    await consumer.processBatch(batch);
  },
};
```

## Configuration

```typescript
interface CloudflareQueuesConfig {
  driver: 'cloudflare-queues';
  queue?: Queue;        // Queue binding, e.g. env.MY_QUEUE (required for the producer)
  queueName?: string;   // For logging/metadata only
}
```

## Features

- Fire-and-forget publish (`send`) and batch publish (`sendBatch`, auto-chunked at 100 messages)
- Push-based consumption: wrap a delivered `MessageBatch` via `processBatch()`
- Per-message `ack()` / `retry()` mapped onto anyq's `ack()` / `nack(requeue)`
- Native delayed redelivery via `Message#retry({ delaySeconds })`

## Retry strategies

This adapter participates in the opt-in pluggable retry strategies from `@anyq/core`. Pass a strategy via `BaseQueueConfig.strategy` and `CloudflareQueuesConsumer.applyStrategy()` takes over per-message error handling inside `processBatch()`; omit it and the legacy behaviour (log + emit `error`, `nack(true)` to retry) runs unchanged.

| Capability | Support |
|---|---|
| `supportsNativeDelay` | **true** |
| Native `park` | `Message#retry({ delaySeconds })` |
| `deadLetterMessage` | default (`nack(false)` → `ack()`, dropping the message). Configure a dead letter queue on the Cloudflare Queue itself (`wrangler.toml`) if you want broker-native DLQ routing |

```typescript
import { backpressurePause } from '@anyq/core';

const consumer = new CloudflareQueuesConsumer({
  driver: 'cloudflare-queues',
  strategy: backpressurePause({ pauseMs: 30_000 }),
});
```

See `@anyq/core` for the full strategy catalogue.

## License

MIT
