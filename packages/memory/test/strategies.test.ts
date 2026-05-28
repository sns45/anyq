/**
 * @fileoverview Memory adapter strategy integration tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  retryThenDeadLetter,
  logAndSkip,
  deadLetterImmediate,
} from '@anyq/core';
import { MemoryProducer, MemoryConsumer, clearAllQueues } from '../src/index.js';
import type { MemoryQueueConfig } from '../src/config.js';

describe('Memory adapter + strategies', () => {
  beforeEach(() => clearAllQueues());
  afterEach(() => clearAllQueues());

  test('retryThenDeadLetter lands message in DLQ after maxAttempts', async () => {
    const config: MemoryQueueConfig = {
      driver: 'memory',
      queueName: 'strategy-retry-dlq',
      deadLetterQueue: {
        enabled: true,
        destination: 'strategy-retry-dlq-dead',
        maxDeliveryAttempts: 2,
        includeError: true,
      },
      strategy: retryThenDeadLetter({ maxAttempts: 2, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitter: false } }),
    };

    const producer = new MemoryProducer<{ id: string }>(config);
    const consumer = new MemoryConsumer<{ id: string }>(config);

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'fail-me' });

      let invocations = 0;
      await consumer.subscribe(
        async () => {
          invocations++;
          throw new Error('ECONNRESET transient');
        },
        { autoAck: false },
      );

      await new Promise((r) => setTimeout(r, 300));

      const dlq = consumer.getDLQ();
      expect(dlq).toBeDefined();
      expect(dlq?.size()).toBeGreaterThan(0);
      // Strategy retried in-process; handler called more than once for the same msg.
      expect(invocations).toBeGreaterThanOrEqual(2);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  });

  test('logAndSkip drops messages and leaves DLQ empty', async () => {
    const config: MemoryQueueConfig = {
      driver: 'memory',
      queueName: 'strategy-skip',
      deadLetterQueue: {
        enabled: true,
        destination: 'strategy-skip-dead',
        maxDeliveryAttempts: 3,
        includeError: true,
      },
      strategy: logAndSkip(),
    };

    const producer = new MemoryProducer<{ id: string }>(config);
    const consumer = new MemoryConsumer<{ id: string }>(config);

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'drop-me' });

      await consumer.subscribe(
        async () => {
          throw new Error('always fails');
        },
        { autoAck: false },
      );

      await new Promise((r) => setTimeout(r, 200));

      const dlq = consumer.getDLQ();
      expect(dlq?.size() ?? 0).toBe(0);
      // Main queue should be drained (message was acked away).
      expect(consumer.getQueue()?.size() ?? 0).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  });

  test('deadLetterImmediate hits DLQ on first failure', async () => {
    const config: MemoryQueueConfig = {
      driver: 'memory',
      queueName: 'strategy-dl-immediate',
      deadLetterQueue: {
        enabled: true,
        destination: 'strategy-dl-immediate-dead',
        maxDeliveryAttempts: 99,
        includeError: true,
      },
      strategy: deadLetterImmediate(),
    };

    const producer = new MemoryProducer<{ id: string }>(config);
    const consumer = new MemoryConsumer<{ id: string }>(config);

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'poison' });

      let calls = 0;
      await consumer.subscribe(
        async () => {
          calls++;
          throw new Error('poison payload');
        },
        { autoAck: false },
      );

      await new Promise((r) => setTimeout(r, 200));

      const dlq = consumer.getDLQ();
      expect(dlq?.size() ?? 0).toBeGreaterThan(0);
      // Should NOT have been retried in-process by the strategy.
      expect(calls).toBe(1);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  });

  test('no strategy preserves legacy DLQ-after-maxDeliveryAttempts behaviour', async () => {
    // Compatibility guard: identical to the existing DLQ test but explicit.
    const config: MemoryQueueConfig = {
      driver: 'memory',
      queueName: 'strategy-legacy',
      deadLetterQueue: {
        enabled: true,
        destination: 'strategy-legacy-dead',
        maxDeliveryAttempts: 2,
        includeError: true,
      },
    };

    const producer = new MemoryProducer<{ id: string }>(config);
    const consumer = new MemoryConsumer<{ id: string }>(config);

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'fail' });

      await consumer.subscribe(
        async () => {
          throw new Error('processing failed');
        },
        { autoAck: false },
      );

      await new Promise((r) => setTimeout(r, 200));

      const dlq = consumer.getDLQ();
      expect(dlq?.size() ?? 0).toBeGreaterThan(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  });
});
