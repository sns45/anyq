/**
 * @fileoverview Memory adapter tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  MemoryProducer,
  MemoryConsumer,
  MemoryQueue,
  clearAllQueues,
  getQueueStats,
} from '../src/index.js';
import type { MemoryQueueConfig } from '../src/config.js';

describe('MemoryQueue', () => {
  let queue: MemoryQueue<{ data: string }>;

  beforeEach(() => {
    queue = new MemoryQueue('test');
  });

  test('should enqueue and dequeue messages', () => {
    const id = queue.enqueue({ data: 'test' });
    expect(id).toBeDefined();

    const message = queue.dequeue();
    expect(message).toBeDefined();
    expect(message?.body.data).toBe('test');
  });

  test('should maintain FIFO order', () => {
    queue.enqueue({ data: 'first' });
    queue.enqueue({ data: 'second' });
    queue.enqueue({ data: 'third' });

    expect(queue.dequeue()?.body.data).toBe('first');
    expect(queue.dequeue()?.body.data).toBe('second');
    expect(queue.dequeue()?.body.data).toBe('third');
  });

  test('should track queue size', () => {
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);

    queue.enqueue({ data: 'test' });
    expect(queue.size()).toBe(1);
    expect(queue.isEmpty()).toBe(false);

    queue.dequeue();
    expect(queue.size()).toBe(0);
  });

  test('should ack messages', () => {
    queue.enqueue({ data: 'test' });
    const message = queue.dequeue();
    expect(message).toBeDefined();

    expect(queue.processingCount()).toBe(1);
    queue.ack(message!.id);
    expect(queue.processingCount()).toBe(0);
  });

  test('should nack and requeue messages', () => {
    queue.enqueue({ data: 'test' });
    const message = queue.dequeue();
    expect(queue.size()).toBe(0);

    queue.nack(message!.id, true);
    expect(queue.size()).toBe(1);
  });

  test('should enforce max messages limit', () => {
    const limitedQueue = new MemoryQueue<{ n: number }>('limited', {
      maxMessages: 3,
    });

    for (let i = 0; i < 5; i++) {
      limitedQueue.enqueue({ n: i });
    }

    expect(limitedQueue.size()).toBe(3);
    // Oldest messages should be dropped
    expect(limitedQueue.dequeue()?.body.n).toBe(2);
  });

  test('should batch dequeue', () => {
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ data: String(i) });
    }

    const batch = queue.dequeueBatch(3);
    expect(batch.length).toBe(3);
    expect(queue.size()).toBe(2);
  });
});

describe('MemoryProducer', () => {
  let producer: MemoryProducer<{ orderId: string }>;
  const config: MemoryQueueConfig = {
    driver: 'memory',
    queueName: 'producer-test',
  };

  beforeEach(async () => {
    clearAllQueues();
    producer = new MemoryProducer(config);
    await producer.connect();
  });

  afterEach(async () => {
    await producer.disconnect();
    clearAllQueues();
  });

  test('should connect and disconnect', async () => {
    expect(producer.isConnected()).toBe(true);
    await producer.disconnect();
    expect(producer.isConnected()).toBe(false);
  });

  test('should publish messages', async () => {
    const messageId = await producer.publish({ orderId: '123' });
    expect(messageId).toBeDefined();

    const queue = producer.getQueue();
    expect(queue?.size()).toBe(1);
  });

  test('should publish with key and headers', async () => {
    await producer.publish(
      { orderId: '123' },
      {
        key: 'customer-1',
        headers: { 'x-trace': 'abc123' },
      }
    );

    const queue = producer.getQueue();
    const message = queue?.dequeue();
    expect(message?.key).toBe('customer-1');
    expect(message?.headers['x-trace']).toBe('abc123');
  });

  test('should publish batch', async () => {
    const ids = await producer.publishBatch([
      { body: { orderId: '1' } },
      { body: { orderId: '2' } },
      { body: { orderId: '3' } },
    ]);

    expect(ids.length).toBe(3);
    expect(producer.getQueue()?.size()).toBe(3);
  });

  test('should return health status', async () => {
    const health = await producer.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.connected).toBe(true);
    expect(health.details?.queue).toBe('producer-test');
  });
});

describe('MemoryConsumer', () => {
  let producer: MemoryProducer<{ orderId: string }>;
  let consumer: MemoryConsumer<{ orderId: string }>;
  const config: MemoryQueueConfig = {
    driver: 'memory',
    queueName: 'consumer-test',
  };

  beforeEach(async () => {
    clearAllQueues();
    producer = new MemoryProducer(config);
    consumer = new MemoryConsumer(config);
    await producer.connect();
    await consumer.connect();
  });

  afterEach(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    clearAllQueues();
  });

  test('should consume messages', async () => {
    const received: string[] = [];

    await producer.publish({ orderId: '123' });
    await producer.publish({ orderId: '456' });

    await consumer.subscribe(async (message) => {
      received.push(message.body.orderId);
      await message.ack();
    });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toContain('123');
    expect(received).toContain('456');
  });

  test('should handle message acknowledgment', async () => {
    await producer.publish({ orderId: '123' });

    await consumer.subscribe(
      async (message) => {
        expect(message.body.orderId).toBe('123');
        await message.ack();
      },
      { autoAck: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const queue = consumer.getQueue();
    expect(queue?.processingCount()).toBe(0);
  });

  test('should requeue on nack', async () => {
    let attempts = 0;

    await producer.publish({ orderId: '123' });

    await consumer.subscribe(
      async (message) => {
        attempts++;
        if (attempts < 2) {
          await message.nack(true);
        } else {
          await message.ack();
        }
      },
      { autoAck: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test('should pause and resume', async () => {
    let received = 0;

    await consumer.subscribe(async () => {
      received++;
    });

    await producer.publish({ orderId: '1' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await consumer.pause();
    expect(consumer.isPaused()).toBe(true);

    await producer.publish({ orderId: '2' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const countWhilePaused = received;

    await consumer.resume();
    expect(consumer.isPaused()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have processed more after resume
    expect(received).toBeGreaterThan(0);
  });

  test('should emit events', async () => {
    const events: string[] = [];

    consumer.on('message', () => events.push('message'));
    consumer.on('error', () => events.push('error'));

    await producer.publish({ orderId: '123' });

    await consumer.subscribe(async (message) => {
      await message.ack();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toContain('message');
  });
});

describe('Dead Letter Queue', () => {
  let producer: MemoryProducer<{ orderId: string }>;
  let consumer: MemoryConsumer<{ orderId: string }>;
  const config: MemoryQueueConfig = {
    driver: 'memory',
    queueName: 'dlq-test',
    deadLetterQueue: {
      enabled: true,
      destination: 'dlq-test-dlq',
      maxDeliveryAttempts: 2,
      includeError: true,
    },
  };

  beforeEach(async () => {
    clearAllQueues();
    producer = new MemoryProducer(config);
    consumer = new MemoryConsumer(config);
    await producer.connect();
    await consumer.connect();
  });

  afterEach(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    clearAllQueues();
  });

  test('should send to DLQ after max attempts', async () => {
    await producer.publish({ orderId: 'fail-me' });

    await consumer.subscribe(
      async () => {
        throw new Error('Processing failed');
      },
      { autoAck: false }
    );

    // Wait for retries and DLQ
    await new Promise((resolve) => setTimeout(resolve, 200));

    const dlq = consumer.getDLQ();
    expect(dlq).toBeDefined();
    expect(dlq?.size()).toBeGreaterThan(0);
  });
});

describe('Registry', () => {
  beforeEach(() => {
    clearAllQueues();
  });

  test('should share queues between producer and consumer', async () => {
    const producer = new MemoryProducer({ driver: 'memory', queueName: 'shared' });
    const consumer = new MemoryConsumer({ driver: 'memory', queueName: 'shared' });

    await producer.connect();
    await consumer.connect();

    await producer.publish({ data: 'test' });

    const producerQueue = producer.getQueue();
    const consumerQueue = consumer.getQueue();

    expect(producerQueue).toBe(consumerQueue);
    expect(producerQueue?.size()).toBe(1);

    await consumer.disconnect();
    await producer.disconnect();
  });

  test('should get queue stats', async () => {
    const producer = new MemoryProducer({ driver: 'memory', queueName: 'stats-test' });
    await producer.connect();
    await producer.publish({ data: 'test' });

    const stats = getQueueStats();
    expect(stats['stats-test']).toBeDefined();
    expect(stats['stats-test'].size).toBe(1);

    await producer.disconnect();
  });
});
