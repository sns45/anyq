/**
 * @fileoverview @anyq/pgmq integration tests
 *
 * Requires a Postgres with pgmq. Set `PGMQ_URL`, for example:
 *
 *   docker run -d --name pgmq -e POSTGRES_PASSWORD=postgres -p 5433:5432 quay.io/tembo/pg17-pgmq:latest
 *   PGMQ_URL=postgres://postgres:postgres@localhost:5433/postgres bun test
 *
 * Without `PGMQ_URL` the whole suite is skipped so `bun run test` at the
 * monorepo root stays green on machines without Docker.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import {
  retryThenDeadLetter,
  deadLetterImmediate,
  backpressurePause,
  logAndSkip,
  logAndFail,
  ConfigurationError,
  type IMessage,
  type Logger,
} from '@anyq/core';
import {
  PgmqProducer,
  PgmqConsumer,
  createPgmqProducer,
  createPgmqConsumer,
} from '../src/index.js';
import type { PgmqConfig } from '../src/config.js';

const PGMQ_URL = process.env.PGMQ_URL;
const describeIf = PGMQ_URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  stepMs = 50,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return await pred();
}

/** Collects log lines so tests can assert on (the absence of) warnings. */
function recordingLogger(): { logger: Logger; lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  const push = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}

describeIf('@anyq/pgmq integration', () => {
  let admin: pg.Pool;
  const queues: string[] = [];
  const suffix = Date.now().toString(36);

  /** Unique, cleaned up queue name. Keep `name` short: pgmq caps names at 47 chars. */
  const q = (name: string): string => {
    const n = `ts_${name}_${suffix}`;
    queues.push(n);
    return n;
  };

  const base = (queueName: string, extra: Partial<PgmqConfig> = {}): PgmqConfig => ({
    driver: 'pgmq',
    queueName,
    pg: { connectionString: PGMQ_URL },
    logging: { level: 'error' },
    consumer: {
      visibilityTimeout: 5,
      longPollSeconds: 1,
      longPollIntervalMs: 50,
      pollingInterval: 50,
    },
    ...extra,
  });

  const queueLength = async (name: string): Promise<number> => {
    const { rows } = await admin.query<{ queue_length: string }>(
      'SELECT queue_length FROM pgmq.metrics($1)',
      [name],
    );
    return Number(rows[0]?.queue_length ?? 0);
  };

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: PGMQ_URL });
  });

  afterAll(async () => {
    for (const name of queues) {
      await admin.query('SELECT pgmq.drop_queue($1)', [name]).catch(() => undefined);
    }
    await admin.end();
  });

  test('rejects an invalid queue name at construction', () => {
    expect(() => new PgmqProducer(base('bad-name'))).toThrow(ConfigurationError);
    expect(() => new PgmqConsumer(base('x'.repeat(48)))).toThrow(ConfigurationError);
  });

  test('publish, consume, ack: body, key, headers and metadata round trip', async () => {
    const name = q('rt');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    const received: IMessage<{ n: number }>[] = [];

    try {
      await producer.connect();
      await consumer.connect();

      const id = await producer.publish({ n: 1 }, { key: 'k1', headers: { 'x-a': 'b' } });
      expect(id).toMatch(/^\d+$/);

      await consumer.subscribe(async (m) => {
        received.push(m);
      });

      expect(await waitFor(() => received.length === 1)).toBe(true);
      const m = received[0];
      expect(m.id).toBe(id);
      expect(m.body).toEqual({ n: 1 });
      expect(m.key).toBe('k1');
      expect(m.headers['x-a']).toBe('b');
      expect(m.headers['x-anyq-key']).toBeUndefined();
      expect(m.deliveryAttempt).toBe(1);
      expect(m.metadata.provider).toBe('pgmq');
      expect(m.metadata.pgmq?.queueName).toBe(name);
      expect(m.metadata.pgmq?.msgId).toBe(id);
      expect(m.metadata.pgmq?.readCount).toBe(1);
      expect(m.metadata.pgmq?.enqueuedAt).toBeInstanceOf(Date);
      expect(m.metadata.pgmq?.visibleAt).toBeInstanceOf(Date);

      // autoAck deleted it
      expect(await waitFor(async () => (await queueLength(name)) === 0 ? true : false)).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('nack(requeue=true) redelivers with deliveryAttempt 2', async () => {
    const name = q('nackr');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    const attempts: number[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ n: 1 });

      await consumer.subscribe(
        async (m) => {
          attempts.push(m.deliveryAttempt);
          if (m.deliveryAttempt === 1) {
            await m.nack(true);
          } else {
            await m.ack();
          }
        },
        { autoAck: false },
      );

      expect(await waitFor(() => attempts.length === 2)).toBe(true);
      expect(attempts).toEqual([1, 2]);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('nack(requeue=false) archives the message instead of dropping it', async () => {
    const name = q('nacka');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    let seen = 0;

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ n: 1 });

      await consumer.subscribe(
        async (m) => {
          seen++;
          await m.nack(false);
        },
        { autoAck: false },
      );

      expect(await waitFor(() => seen === 1)).toBe(true);
      await sleep(200);
      expect(await queueLength(name)).toBe(0);
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgmq.a_${name}`,
      );
      expect(rows[0].n).toBe(1);
      expect(seen).toBe(1);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('publishBatch returns ids in order and subscribeBatch receives them all', async () => {
    const name = q('batch');
    const producer = new PgmqProducer<{ i: number }>(base(name));
    const consumer = new PgmqConsumer<{ i: number }>(base(name));
    const received: number[] = [];

    try {
      await producer.connect();
      await consumer.connect();

      const ids = await producer.publishBatch(
        Array.from({ length: 5 }, (_, i) => ({ body: { i }, options: { headers: { idx: String(i) } } })),
      );
      expect(ids).toHaveLength(5);
      const numeric = ids.map((s) => Number(s));
      expect([...numeric].sort((a, b) => a - b)).toEqual(numeric);

      await consumer.subscribeBatch(
        async (messages) => {
          for (const m of messages) received.push(m.body.i);
        },
        { batchSize: 10 },
      );

      expect(await waitFor(() => received.length === 5)).toBe(true);
      expect([...received].sort()).toEqual([0, 1, 2, 3, 4]);
      expect(await waitFor(async () => (await queueLength(name)) === 0 ? true : false)).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('publishBatch with mixed delays preserves input order of ids', async () => {
    const name = q('mixed');
    const producer = new PgmqProducer<{ i: number }>(base(name));
    try {
      await producer.connect();
      const ids = await producer.publishBatch([
        { body: { i: 0 }, options: { delaySeconds: 60 } },
        { body: { i: 1 } },
        { body: { i: 2 }, options: { delaySeconds: 60 } },
        { body: { i: 3 } },
      ]);
      expect(ids).toHaveLength(4);
      const { rows } = await admin.query<{ msg_id: string; message: { i: number } }>(
        `SELECT msg_id::text, message FROM pgmq.q_${name} ORDER BY msg_id`,
      );
      const byId = new Map(rows.map((r) => [r.msg_id, r.message.i]));
      ids.forEach((id, i) => expect(byId.get(id)).toBe(i));
    } finally {
      await producer.disconnect();
    }
  }, 20000);

  test('delaySeconds hides the message until the delay passes', async () => {
    const name = q('delay');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    const received: IMessage[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      await consumer.subscribe(async (m) => {
        received.push(m);
      });

      await producer.publish({ n: 1 }, { delaySeconds: 2 });
      await sleep(1000);
      expect(received).toHaveLength(0);
      expect(await waitFor(() => received.length === 1, 5000)).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('extendDeadline keeps a slow message invisible to a second consumer', async () => {
    const name = q('extend');
    const short = base(name, {
      consumer: { visibilityTimeout: 2, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
    });
    const producer = new PgmqProducer<{ n: number }>(short);
    const slow = new PgmqConsumer<{ n: number }>(short);
    const other = new PgmqConsumer<{ n: number }>(short);
    let slowDone = false;
    const otherSeen: string[] = [];

    try {
      await producer.connect();
      await slow.connect();
      await other.connect();

      await producer.publish({ n: 1 });

      await slow.subscribe(
        async (m) => {
          // Lease is 2s; extend to 6s then work for 3s. Without the extension
          // `other` would read it at ~2s.
          await m.extendDeadline!(6);
          await sleep(3000);
          await m.ack();
          slowDone = true;
        },
        { autoAck: false },
      );
      await sleep(200);
      await other.subscribe(async (m) => {
        otherSeen.push(m.id);
      });

      expect(await waitFor(() => slowDone, 10000)).toBe(true);
      await sleep(1000);
      expect(otherSeen).toHaveLength(0);
    } finally {
      await other.disconnect();
      await slow.disconnect();
      await producer.disconnect();
    }
  }, 30000);

  test('pause stops delivery and resume restarts it', async () => {
    const name = q('pause');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    const received: IMessage[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      await consumer.subscribe(async (m) => {
        received.push(m);
      });

      await consumer.pause();
      expect(consumer.isPaused()).toBe(true);
      await producer.publish({ n: 1 });
      await sleep(1500);
      expect(received).toHaveLength(0);

      await consumer.resume();
      expect(await waitFor(() => received.length === 1)).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('healthCheck reports latency and queue depth', async () => {
    const name = q('health');
    const producer = createPgmqProducer<{ n: number }>({ queueName: name, pg: { connectionString: PGMQ_URL } });
    const consumer = createPgmqConsumer<{ n: number }>({ queueName: name, pg: { connectionString: PGMQ_URL } });

    try {
      expect((await consumer.healthCheck()).healthy).toBe(false);
      await producer.connect();
      await consumer.connect();
      await producer.publish({ n: 1 });

      const p = await producer.healthCheck();
      const c = await consumer.healthCheck();
      expect(p.healthy).toBe(true);
      expect(c.healthy).toBe(true);
      expect(typeof p.latencyMs).toBe('number');
      expect(p.details?.queue).toBe(name);
      expect(p.details?.queueLength).toBe(1);
      expect(c.details?.longPoll).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('retryThenDeadLetter lands the message in the DLQ with death headers', async () => {
    const name = q('rtdl');
    const dlq = q('rtdl_d');
    const config = base(name, {
      deadLetterQueue: { enabled: true, destination: dlq, maxDeliveryAttempts: 2, includeError: true },
      strategy: retryThenDeadLetter({
        maxAttempts: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, jitter: false },
      }),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);
    let invocations = 0;

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'fail-me' }, { key: 'k', headers: { 'x-a': 'b' } });

      await consumer.subscribe(
        async () => {
          invocations++;
          throw new Error('ECONNRESET transient');
        },
        { autoAck: false },
      );

      expect(await waitFor(async () => (await queueLength(dlq)) === 1 ? true : false)).toBe(true);
      expect(invocations).toBeGreaterThanOrEqual(2);
      expect(await queueLength(name)).toBe(0);

      const { rows } = await admin.query<{ headers: Record<string, string>; message: { id: string } }>(
        `SELECT headers, message FROM pgmq.q_${dlq}`,
      );
      expect(rows[0].message).toEqual({ id: 'fail-me' });
      expect(rows[0].headers['x-original-queue']).toBe(name);
      expect(rows[0].headers['x-death-reason']).toBeDefined();
      expect(rows[0].headers['x-delivery-attempts']).toBe('1');
      expect(rows[0].headers['x-a']).toBe('b');
      expect(rows[0].headers['x-anyq-key']).toBe('k');
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('deadLetterImmediate hits the DLQ on the first failure', async () => {
    const name = q('dli');
    const dlq = q('dli_d');
    const config = base(name, {
      deadLetterQueue: { enabled: true, destination: dlq, maxDeliveryAttempts: 99, includeError: true },
      strategy: deadLetterImmediate(),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);
    let calls = 0;

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'poison' });

      await consumer.subscribe(
        async () => {
          calls++;
          throw new Error('poison payload');
        },
        { autoAck: false },
      );

      expect(await waitFor(async () => (await queueLength(dlq)) === 1 ? true : false)).toBe(true);
      await sleep(300);
      expect(calls).toBe(1);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('logAndSkip acks the message and leaves the DLQ empty', async () => {
    const name = q('skip');
    const dlq = q('skip_d');
    const config = base(name, {
      deadLetterQueue: { enabled: true, destination: dlq, maxDeliveryAttempts: 3, includeError: true },
      strategy: logAndSkip(),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);

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

      expect(await waitFor(async () => (await queueLength(name)) === 0 ? true : false)).toBe(true);
      expect(await queueLength(dlq)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('backpressurePause parks natively: no downgrade warning, redelivered later with attempt 2', async () => {
    const name = q('park');
    const { logger, lines } = recordingLogger();
    const config = base(name, {
      logging: { enabled: true, level: 'debug', logger },
      strategy: backpressurePause({ pauseMs: 1500 }),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);
    const deliveries: Array<{ attempt: number; at: number }> = [];

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'throttled' });

      await consumer.subscribe(
        async (m) => {
          deliveries.push({ attempt: m.deliveryAttempt, at: Date.now() });
          if (m.deliveryAttempt === 1) {
            throw new Error('rate limit exceeded');
          }
          await m.ack();
        },
        { autoAck: false },
      );

      expect(await waitFor(() => deliveries.length === 2, 12000)).toBe(true);
      expect(deliveries.map((d) => d.attempt)).toEqual([1, 2]);
      // park was ceil(1500 / 1000) = 2s; the second delivery cannot come sooner
      expect(deliveries[1].at - deliveries[0].at).toBeGreaterThanOrEqual(1900);

      const downgrade = lines.filter((l) => /downgrad/i.test(l.message));
      expect(downgrade).toHaveLength(0);
      expect(lines.some((l) => l.message === 'Message parked for redelivery')).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 30000);

  test('concurrency handles leased rows in parallel so no lease idles behind a slow handler', async () => {
    const name = q('conc');
    const short = base(name, {
      consumer: { visibilityTimeout: 2, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
    });
    const producer = new PgmqProducer<{ i: number }>(short);
    const a = new PgmqConsumer<{ i: number }>(short);
    const b = new PgmqConsumer<{ i: number }>(short);
    const aStarts: number[] = [];
    const aIds: string[] = [];
    const bIds: string[] = [];

    try {
      await producer.connect();
      await a.connect();
      await b.connect();
      await producer.publishBatch([{ body: { i: 0 } }, { body: { i: 1 } }, { body: { i: 2 } }]);

      // Three rows leased for 2s, each handler takes 1.5s. Sequential handling
      // would let the second and third leases expire and `b` would steal them.
      await a.subscribe(
        async (m) => {
          aStarts.push(Date.now());
          aIds.push(m.id);
          await sleep(1500);
        },
        { concurrency: 3 },
      );
      await sleep(150);
      await b.subscribe(async (m) => {
        bIds.push(m.id);
      });

      expect(await waitFor(() => aIds.length === 3, 6000)).toBe(true);
      expect(Math.max(...aStarts) - Math.min(...aStarts)).toBeLessThan(1000);
      await sleep(3000);
      expect(bIds).toHaveLength(0);
      expect(new Set(aIds).size).toBe(3);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await b.disconnect();
      await a.disconnect();
      await producer.disconnect();
    }
  }, 30000);

  test('an explicit nack(true) inside the handler is not undone by autoAck', async () => {
    const name = q('nackauto');
    const producer = new PgmqProducer<{ n: number }>(base(name));
    const consumer = new PgmqConsumer<{ n: number }>(base(name));
    const attempts: number[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ n: 1 });

      // autoAck stays on (default); the handler returns normally after nacking.
      await consumer.subscribe(async (m) => {
        attempts.push(m.deliveryAttempt);
        if (m.deliveryAttempt === 1) {
          await m.nack(true);
        }
      });

      expect(await waitFor(() => attempts.length === 2)).toBe(true);
      expect(attempts).toEqual([1, 2]);
      await sleep(200);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('a failed DLQ transfer archives nothing and the message is retried after the lease', async () => {
    const name = q('dlqfail');
    const dlq = q('dlqfail_d');
    const config = base(name, {
      consumer: { visibilityTimeout: 2, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
      deadLetterQueue: { enabled: true, destination: dlq, maxDeliveryAttempts: 99, includeError: true },
      strategy: deadLetterImmediate(),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);
    const attempts: number[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      // Break the DLQ after connect() created it.
      await admin.query('SELECT pgmq.drop_queue($1)', [dlq]);
      await producer.publish({ id: 'poison' });

      await consumer.subscribe(
        async (m) => {
          attempts.push(m.deliveryAttempt);
          if (m.deliveryAttempt === 2) {
            await admin.query('SELECT pgmq.create($1)', [dlq]);
          }
          throw new Error('poison payload');
        },
        { autoAck: false },
      );

      expect(
        await waitFor(async () => (await queueLength(dlq).catch(() => -1)) === 1, 10000),
      ).toBe(true);
      expect(attempts).toEqual([1, 2]);
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgmq.a_${name}`,
      );
      expect(rows[0].n).toBe(0);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 30000);

  test('dead letter writes no DLQ copy when the source message is already gone', async () => {
    const name = q('dlqgone');
    const dlq = q('dlqgone_d');
    const config = base(name, {
      deadLetterQueue: { enabled: true, destination: dlq, maxDeliveryAttempts: 99, includeError: true },
      strategy: deadLetterImmediate(),
    });
    const producer = new PgmqProducer<{ id: string }>(config);
    const consumer = new PgmqConsumer<{ id: string }>(config);
    let calls = 0;

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publish({ id: 'poison' });

      await consumer.subscribe(
        async (m) => {
          calls++;
          // Another consumer (or an expired lease) finished the message first.
          await admin.query('SELECT pgmq.delete($1, $2::bigint)', [name, m.id]);
          throw new Error('poison payload');
        },
        { autoAck: false },
      );

      expect(await waitFor(() => calls === 1)).toBe(true);
      await sleep(500);
      expect(await queueLength(dlq)).toBe(0);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('a failed ack does not mark the message settled, so a retry still deletes it', async () => {
    const name = q('ackretry');
    const short = base(name, {
      consumer: { visibilityTimeout: 2, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
    });
    const producer = new PgmqProducer<{ n: number }>(short);
    const consumer = new PgmqConsumer<{ n: number }>(short);
    const attempts: number[] = [];
    let firstAckError: unknown;

    try {
      await producer.connect();
      await consumer.connect();

      // Make the first pgmq.delete fail, as a connection blip would.
      const pool = consumer.getPool()!;
      const patched = pool as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const original = patched.query.bind(pool);
      let injectOnce = true;
      patched.query = (...args: unknown[]) => {
        if (injectOnce && String(args[0]).includes('pgmq.delete')) {
          injectOnce = false;
          return Promise.reject(new Error('injected delete failure'));
        }
        return original(...args);
      };

      await producer.publish({ n: 1 });
      await consumer.subscribe(
        async (m) => {
          attempts.push(m.deliveryAttempt);
          try {
            await m.ack();
          } catch (err) {
            firstAckError = err;
          }
          await m.ack(); // retry must really delete
        },
        { autoAck: false },
      );

      expect(await waitFor(() => attempts.length === 1)).toBe(true);
      expect(firstAckError).toBeInstanceOf(Error);
      await sleep(3500); // longer than the 2s lease
      expect(attempts).toEqual([1]);
      expect(await queueLength(name)).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('a fail decision does not let the next poll overlap sibling handlers', async () => {
    const name = q('failoverlap');
    const short = base(name, {
      consumer: { visibilityTimeout: 2, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
      strategy: logAndFail(),
    });
    const producer = new PgmqProducer<{ i: number }>(short);
    const consumer = new PgmqConsumer<{ i: number }>(short);
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publishBatch(Array.from({ length: 6 }, (_, i) => ({ body: { i } })));

      await consumer.subscribe(
        async (m) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            if (m.body.i % 3 === 0 && m.deliveryAttempt === 1) {
              throw new Error('poison'); // logAndFail turns this into a fail decision
            }
            await sleep(1500);
            done.push(m.body.i);
          } finally {
            inFlight--;
          }
        },
        { concurrency: 3 },
      );

      // Six messages, three per poll; the two poison ones come back after
      // the 2s lease and succeed on attempt 2.
      expect(await waitFor(() => done.length === 6, 15000)).toBe(true);
      expect(maxInFlight).toBeLessThanOrEqual(3);
      expect(await waitFor(async () => (await queueLength(name)) === 0, 5000)).toBe(true);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 30000);

  test('disconnect waits for sibling handlers even after a fail decision', async () => {
    const name = q('faildisc');
    const short = base(name, {
      consumer: { visibilityTimeout: 5, longPollSeconds: 1, longPollIntervalMs: 50, pollingInterval: 50 },
      strategy: logAndFail(),
    });
    const producer = new PgmqProducer<{ i: number }>(short);
    const consumer = new PgmqConsumer<{ i: number }>(short);
    let inFlight = 0;

    try {
      await producer.connect();
      await consumer.connect();
      await producer.publishBatch([{ body: { i: 0 } }, { body: { i: 1 } }, { body: { i: 2 } }]);

      await consumer.subscribe(
        async (m) => {
          if (m.body.i === 0) {
            throw new Error('poison'); // fail decision, rejects at once
          }
          inFlight++;
          try {
            await sleep(1500);
            await m.ack();
          } finally {
            inFlight--;
          }
        },
        { concurrency: 3, autoAck: false },
      );

      await waitFor(() => inFlight === 2, 3000);
      const started = Date.now();
      await consumer.disconnect();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
      expect(inFlight).toBe(0);
    } finally {
      await consumer.disconnect();
      await producer.disconnect();
    }
  }, 20000);

  test('connecting to a database without pgmq (autoInstall off) names the SQL only install path', async () => {
    const dbName = `anyq_nopgmq_${suffix}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PGMQ_URL!);
    url.pathname = `/${dbName}`;
    const producer = new PgmqProducer<{ n: number }>({
      driver: 'pgmq',
      queueName: 'irrelevant',
      pg: { connectionString: url.toString() },
      autoInstall: false,
      logging: { level: 'error' },
    });

    try {
      let caught: unknown;
      try {
        await producer.connect();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as Error).message).toContain('pgmq-extension/sql/pgmq.sql');
      expect(producer.isConnected()).toBe(false);
    } finally {
      await producer.disconnect();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
    }
  }, 20000);
});
