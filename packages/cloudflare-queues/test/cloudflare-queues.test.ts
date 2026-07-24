/**
 * @fileoverview Cloudflare Queues adapter tests
 *
 * Two layers:
 *  - Mock-based unit tests: fast, deterministic coverage of the producer and
 *    consumer against hand-built `Queue`/`MessageBatch`/`Message` doubles.
 *  - Miniflare round-trip tests: boot a real workerd instance via Miniflare,
 *    bundle a tiny fixture Worker that wires up `CloudflareQueuesConsumer`,
 *    publish through a *real* `Queue` binding obtained from Miniflare, and
 *    assert the platform actually delivers batches to `processBatch()` with
 *    ack/retry mapped correctly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Miniflare } from 'miniflare';
import {
  CloudflareQueuesProducer,
  CloudflareQueuesConsumer,
} from '../src/index.js';
import { ConnectionError } from '@anyq/core';
import type {
  Message as CFMessage,
  MessageBatch,
  Queue,
  QueueRetryOptions,
  QueueSendOptions,
} from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Mock-based unit tests
// ---------------------------------------------------------------------------

/** Minimal mock of the `Queue` binding interface. */
function createMockQueue<T = unknown>() {
  const sent: Array<{ body: T; options?: QueueSendOptions }> = [];
  const sentBatches: Array<{ body: T; contentType?: string; delaySeconds?: number }[]> = [];

  const queue: Queue<T> = {
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 } as never;
    },
    async send(message: T, options?: QueueSendOptions) {
      sent.push({ body: message, options });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } } as never;
    },
    async sendBatch(messages) {
      sentBatches.push([...messages] as never);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } } as never;
    },
  };

  return { queue, sent, sentBatches };
}

/** Minimal mock of a Cloudflare `Message`. */
function createMockMessage<T>(
  id: string,
  body: T,
  attempts = 1
): CFMessage<T> & { acked: boolean; retried: QueueRetryOptions[] } {
  const state = { acked: false, retried: [] as QueueRetryOptions[] };
  return {
    id,
    timestamp: new Date(),
    body,
    attempts,
    ack() {
      state.acked = true;
    },
    retry(options?: QueueRetryOptions) {
      state.retried.push(options ?? {});
    },
    get acked() {
      return state.acked;
    },
    get retried() {
      return state.retried;
    },
  } as never;
}

/** Minimal mock of a `MessageBatch`. */
function createMockBatch<T>(
  messages: CFMessage<T>[],
  queueName = 'test-queue'
): MessageBatch<T> & { retriedAll: boolean; ackedAll: boolean } {
  const state = { retriedAll: false, ackedAll: false };
  return {
    messages,
    queue: queueName,
    metadata: {} as never,
    retryAll() {
      state.retriedAll = true;
    },
    ackAll() {
      state.ackedAll = true;
    },
    get retriedAll() {
      return state.retriedAll;
    },
    get ackedAll() {
      return state.ackedAll;
    },
  } as never;
}

describe('CloudflareQueuesProducer (mock queue)', () => {
  test('connect() throws without a queue binding', async () => {
    const producer = new CloudflareQueuesProducer({ driver: 'cloudflare-queues' });
    await expect(producer.connect()).rejects.toThrow(ConnectionError);
  });

  test('publish() throws when not connected', async () => {
    const producer = new CloudflareQueuesProducer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await expect(producer.publish({ n: 1 })).rejects.toThrow(ConnectionError);
  });

  test('connect() then publish() sends via the binding with contentType json', async () => {
    const { queue, sent } = createMockQueue<{ orderId: string }>();
    const producer = new CloudflareQueuesProducer<{ orderId: string }>({
      driver: 'cloudflare-queues',
      queue,
    });

    await producer.connect();
    expect(producer.isConnected()).toBe(true);

    const id = await producer.publish({ orderId: '123' }, { delaySeconds: 5 });
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ orderId: '123' });
    expect(sent[0]?.options?.contentType).toBe('json');
    expect(sent[0]?.options?.delaySeconds).toBe(5);

    await producer.disconnect();
    expect(producer.isConnected()).toBe(false);
  });

  test('publishBatch() sends all messages and returns one id per message', async () => {
    const { queue, sentBatches } = createMockQueue<{ n: number }>();
    const producer = new CloudflareQueuesProducer<{ n: number }>({
      driver: 'cloudflare-queues',
      queue,
    });
    await producer.connect();

    const ids = await producer.publishBatch([
      { body: { n: 1 } },
      { body: { n: 2 } },
      { body: { n: 3 } },
    ]);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3); // unique ids
    expect(sentBatches).toHaveLength(1);
    expect(sentBatches[0]).toHaveLength(3);
  });

  test('publishBatch() chunks batches larger than 100 messages', async () => {
    const { queue, sentBatches } = createMockQueue<{ n: number }>();
    const producer = new CloudflareQueuesProducer<{ n: number }>({
      driver: 'cloudflare-queues',
      queue,
    });
    await producer.connect();

    const messages = Array.from({ length: 150 }, (_, n) => ({ body: { n } }));
    const ids = await producer.publishBatch(messages);

    expect(ids).toHaveLength(150);
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[0]).toHaveLength(100);
    expect(sentBatches[1]).toHaveLength(50);
  });

  test('healthCheck() reflects connection state', async () => {
    const { queue } = createMockQueue();
    const producer = new CloudflareQueuesProducer({ driver: 'cloudflare-queues', queue });

    const before = await producer.healthCheck();
    expect(before.healthy).toBe(false);
    expect(before.connected).toBe(false);

    await producer.connect();
    const after = await producer.healthCheck();
    expect(after.healthy).toBe(true);
    expect(after.connected).toBe(true);
  });
});

describe('CloudflareQueuesConsumer (mock batch)', () => {
  test('connect() then processBatch() invokes the subscribed handler and acks', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
      queueName: 'test-queue',
    });
    await consumer.connect();

    const received: number[] = [];
    await consumer.subscribe(async (message) => {
      received.push(message.body.n);
    });

    const msg = createMockMessage('m1', { n: 42 });
    const batch = createMockBatch([msg]);

    await consumer.processBatch(batch);

    expect(received).toEqual([42]);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toHaveLength(0);
  });

  test('message metadata identifies the provider and queue', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
      queueName: 'test-queue',
    });
    await consumer.connect();

    let capturedMetadata: unknown;
    await consumer.subscribe(async (message) => {
      capturedMetadata = message.metadata;
    });

    const msg = createMockMessage('m1', { n: 1 }, 3);
    const batch = createMockBatch([msg], 'my-queue');
    await consumer.processBatch(batch);

    expect(capturedMetadata).toEqual({
      provider: 'cloudflare-queues',
      cloudflareQueues: { queueName: 'my-queue', attempts: 3 },
    });
  });

  test('manual nack(true) maps onto Message#retry()', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await consumer.connect();

    await consumer.subscribe(
      async (message) => {
        await message.nack(true);
      },
      { autoAck: false }
    );

    const msg = createMockMessage('m1', { n: 1 });
    await consumer.processBatch(createMockBatch([msg]));

    expect(msg.acked).toBe(false);
    expect(msg.retried).toHaveLength(1);
  });

  test('manual nack(false) maps onto Message#ack() (drop)', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await consumer.connect();

    await consumer.subscribe(
      async (message) => {
        await message.nack(false);
      },
      { autoAck: false }
    );

    const msg = createMockMessage('m1', { n: 1 });
    await consumer.processBatch(createMockBatch([msg]));

    expect(msg.acked).toBe(true);
    expect(msg.retried).toHaveLength(0);
  });

  test('processBatch() with no handler registered retries the whole batch', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await consumer.connect();

    const msg = createMockMessage('m1', { n: 1 });
    const batch = createMockBatch([msg]);
    await consumer.processBatch(batch);

    expect(batch.retriedAll).toBe(true);
  });

  test('pause() retries incoming batches instead of processing them', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await consumer.connect();

    let handled = 0;
    await consumer.subscribe(async () => {
      handled++;
    });

    await consumer.pause();
    expect(consumer.isPaused()).toBe(true);

    const batch = createMockBatch([createMockMessage('m1', { n: 1 })]);
    await consumer.processBatch(batch);

    expect(handled).toBe(0);
    expect(batch.retriedAll).toBe(true);

    await consumer.resume();
    expect(consumer.isPaused()).toBe(false);
  });

  test('subscribeBatch() delivers the whole batch to a batch handler', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
    });
    await consumer.connect();

    let batchSize = 0;
    await consumer.subscribeBatch(async (messages) => {
      batchSize = messages.length;
    });

    const msgs = [createMockMessage('m1', { n: 1 }), createMockMessage('m2', { n: 2 })];
    await consumer.processBatch(createMockBatch(msgs));

    expect(batchSize).toBe(2);
    expect(msgs.every((m) => m.acked)).toBe(true);
  });

  test('a configured retry strategy drives dead-lettering on failure', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
      strategy: {
        name: 'always-dead-letter',
        decide: async () => ({ action: 'deadLetter', reason: 'boom' }),
      },
    });
    await consumer.connect();

    await consumer.subscribe(async () => {
      throw new Error('handler failure');
    });

    const msg = createMockMessage('m1', { n: 1 });
    await consumer.processBatch(createMockBatch([msg]));

    // Default deadLetterMessage() hook drops via nack(false) -> ack().
    expect(msg.acked).toBe(true);
  });

  test('a park decision uses native retry({ delaySeconds })', async () => {
    const consumer = new CloudflareQueuesConsumer<{ n: number }>({
      driver: 'cloudflare-queues',
      strategy: {
        name: 'always-park',
        decide: async () => ({ action: 'park', delayMs: 5000 }),
      },
    });
    await consumer.connect();

    await consumer.subscribe(async () => {
      throw new Error('handler failure');
    });

    const msg = createMockMessage('m1', { n: 1 });
    await consumer.processBatch(createMockBatch([msg]));

    expect(msg.acked).toBe(false);
    expect(msg.retried).toEqual([{ delaySeconds: 5 }]);
  });

  test('healthCheck() reports handler presence', async () => {
    const consumer = new CloudflareQueuesConsumer({ driver: 'cloudflare-queues' });
    const before = await consumer.healthCheck();
    expect(before.details?.hasHandler).toBe(false);

    await consumer.connect();
    await consumer.subscribe(async () => {});

    const after = await consumer.healthCheck();
    expect(after.connected).toBe(true);
    expect(after.details?.hasHandler).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Miniflare round-trip tests
// ---------------------------------------------------------------------------

describe('Cloudflare Queues Miniflare round-trip', () => {
  let mf: Miniflare;

  async function waitFor<T>(
    fn: () => Promise<T | undefined>,
    { timeoutMs = 8000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<T> {
    const start = Date.now();
    for (;;) {
      const result = await fn();
      if (result !== undefined) return result;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor() timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  beforeAll(async () => {
    const build = await Bun.build({
      entrypoints: [new URL('./fixtures/worker.ts', import.meta.url).pathname],
      target: 'browser',
      format: 'esm',
    });

    if (!build.success) {
      const messages = build.logs.map((log) => log.message).join('\n');
      throw new Error(`Failed to bundle Miniflare worker fixture:\n${messages}`);
    }

    const workerScript = await build.outputs[0]!.text();

    mf = new Miniflare({
      modules: true,
      script: workerScript,
      compatibilityDate: '2024-09-23',
      kvNamespaces: ['RESULTS'],
      queueProducers: { TEST_QUEUE: { queueName: 'test-queue' } },
      queueConsumers: {
        'test-queue': {
          maxBatchSize: 5,
          maxBatchTimeout: 0,
          maxRetries: 5,
          retryDelay: 0,
        },
      },
    });

    // Force the worker to boot so early queue deliveries aren't missed.
    await mf.ready;
  }, 30000);

  afterAll(async () => {
    await mf?.dispose();
  });

  async function publish(body: Record<string, unknown>): Promise<void> {
    const queue = await mf.getQueueProducer('TEST_QUEUE');
    const producer = new CloudflareQueuesProducer({
      driver: 'cloudflare-queues',
      queue: queue as never,
    });
    await producer.connect();
    await producer.publish(body);
    await producer.disconnect();
  }

  async function getRecord(id: string, attempt: number): Promise<Record<string, unknown> | undefined> {
    const kv = await mf.getKVNamespace('RESULTS');
    const raw = await kv.get(`msg:${id}:${attempt}`);
    return raw ? JSON.parse(raw) : undefined;
  }

  async function listAttempts(id: string): Promise<string[]> {
    const kv = await mf.getKVNamespace('RESULTS');
    const { keys } = await kv.list({ prefix: `msg:${id}:` });
    return keys.map((k: { name: string }) => k.name);
  }

  test('published message is delivered to the consumer and acked', async () => {
    await publish({ id: 'ok-1', label: 'hello' });

    const record = await waitFor(() => getRecord('ok-1', 1));
    expect(record?.body).toEqual({ id: 'ok-1', label: 'hello' });
    expect(record?.attempts).toBe(1);
    expect(record?.provider).toBe('cloudflare-queues');
    expect((record?.cloudflareQueues as Record<string, unknown> | undefined)?.queueName).toBe(
      'test-queue'
    );

    // Give the platform a beat to (not) redeliver, then confirm ack stuck.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const attempts = await listAttempts('ok-1');
    expect(attempts).toEqual(['msg:ok-1:1']);
  }, 15000);

  test('nack(true) triggers real redelivery with an incremented delivery attempt', async () => {
    await publish({ id: 'retry-1', failUntilAttempt: 2 });

    await waitFor(() => getRecord('retry-1', 1));
    const secondAttempt = await waitFor(() => getRecord('retry-1', 2));

    expect(secondAttempt?.body).toEqual({ id: 'retry-1', failUntilAttempt: 2 });
    expect(secondAttempt?.attempts).toBe(2);

    // It acked on attempt 2, so no third attempt should ever show up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const attempts = await listAttempts('retry-1');
    expect(attempts.sort()).toEqual(['msg:retry-1:1', 'msg:retry-1:2']);
  }, 15000);

  test('nack(false) drops the message without redelivery', async () => {
    await publish({ id: 'drop-1', dropOnFirstAttempt: true });

    await waitFor(() => getRecord('drop-1', 1));

    await new Promise((resolve) => setTimeout(resolve, 500));
    const attempts = await listAttempts('drop-1');
    expect(attempts).toEqual(['msg:drop-1:1']);
  }, 15000);
});
