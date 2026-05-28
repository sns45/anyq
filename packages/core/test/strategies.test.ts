/**
 * @fileoverview Retry strategy unit tests
 */

import { describe, test, expect } from 'bun:test';
import {
  logAndSkip,
  logAndFail,
  retryThenDeadLetter,
  deadLetterImmediate,
  backpressurePause,
  custom,
  AnyQError,
  type IMessage,
  type RetryStrategyContext,
} from '../src/index.js';

function fakeMessage<T>(body: T, deliveryAttempt = 1): IMessage<T> {
  return {
    id: 'm-1',
    body,
    headers: {},
    timestamp: new Date(),
    deliveryAttempt,
    metadata: { provider: 'memory' },
    raw: null,
    ack: async () => undefined,
    nack: async () => undefined,
  };
}

function ctx<T>(
  error: Error,
  body: T = null as unknown as T,
  attempt = 1,
  maxAttempts = 3,
): RetryStrategyContext<T> {
  return {
    message: fakeMessage(body, attempt),
    error,
    attempt,
    maxAttempts,
  };
}

describe('logAndSkip', () => {
  test('returns ack', async () => {
    const s = logAndSkip();
    const decision = await s.decide(ctx(new Error('boom')));
    expect(decision).toEqual({ action: 'ack' });
  });

  test('has stable name', () => {
    expect(logAndSkip().name).toBe('log-and-skip');
  });
});

describe('logAndFail', () => {
  test('returns fail', async () => {
    const s = logAndFail();
    const decision = await s.decide(ctx(new Error('boom')));
    expect(decision).toEqual({ action: 'fail' });
  });
});

describe('retryThenDeadLetter', () => {
  test('retryable under maxAttempts -> retry with positive delayMs', async () => {
    const s = retryThenDeadLetter({ maxAttempts: 5 });
    const decision = await s.decide(
      ctx(new Error('ECONNRESET network error'), null, 1, 5),
    );
    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.delayMs).toBeGreaterThan(0);
    }
  });

  test('retryable at maxAttempts -> deadLetter', async () => {
    const s = retryThenDeadLetter({ maxAttempts: 2 });
    const decision = await s.decide(
      ctx(new Error('ECONNRESET'), null, 2, 2),
    );
    expect(decision.action).toBe('deadLetter');
  });

  test('non-retryable AnyQError -> deadLetter immediately', async () => {
    const err = new AnyQError('bad payload', { retryable: false });
    const s = retryThenDeadLetter({ maxAttempts: 5 });
    const decision = await s.decide(ctx(err, null, 1, 5));
    expect(decision.action).toBe('deadLetter');
    if (decision.action === 'deadLetter') {
      expect(decision.reason).toBe('bad payload');
    }
  });

  test('strategy-level maxAttempts overrides context maxAttempts', async () => {
    const s = retryThenDeadLetter({ maxAttempts: 1 });
    const decision = await s.decide(
      ctx(new Error('ECONNRESET'), null, 1, 99),
    );
    expect(decision.action).toBe('deadLetter');
  });

  test('custom isRetryable predicate is respected', async () => {
    const s = retryThenDeadLetter({
      maxAttempts: 5,
      isRetryable: () => false,
    });
    const decision = await s.decide(
      ctx(new Error('would normally be retryable'), null, 1, 5),
    );
    expect(decision.action).toBe('deadLetter');
  });
});

describe('deadLetterImmediate', () => {
  test('always returns deadLetter', async () => {
    const s = deadLetterImmediate();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const decision = await s.decide(
        ctx(new Error(`fail ${attempt}`), null, attempt, 10),
      );
      expect(decision.action).toBe('deadLetter');
    }
  });
});

describe('backpressurePause', () => {
  test('rate-limited error -> park with pauseMs', async () => {
    const s = backpressurePause({ pauseMs: 1234 });
    const decision = await s.decide(
      ctx(new Error('429 Too Many Requests')),
    );
    expect(decision.action).toBe('park');
    if (decision.action === 'park') {
      expect(decision.delayMs).toBe(1234);
    }
  });

  test('non rate-limited error -> requeue', async () => {
    const s = backpressurePause();
    const decision = await s.decide(ctx(new Error('something else')));
    expect(decision.action).toBe('requeue');
  });

  test('uses BACKPRESSURE_PAUSE_STRATEGY_NAME for signalling', () => {
    expect(backpressurePause().name).toBe('backpressure-pause');
  });

  test('custom isRateLimited predicate is respected', async () => {
    const s = backpressurePause({
      pauseMs: 100,
      isRateLimited: (err) => err.message === 'PAUSE_PLEASE',
    });
    const yes = await s.decide(ctx(new Error('PAUSE_PLEASE')));
    expect(yes.action).toBe('park');
    const no = await s.decide(ctx(new Error('429')));
    expect(no.action).toBe('requeue');
  });
});

describe('custom', () => {
  test('invokes the supplied function and returns its decision', async () => {
    const s = custom('my-strategy', () => ({ action: 'ack' }));
    expect(s.name).toBe('my-strategy');
    const decision = await s.decide(ctx(new Error('whatever')));
    expect(decision).toEqual({ action: 'ack' });
  });

  test('supports async decisions', async () => {
    const s = custom('async-strategy', async () => ({
      action: 'park',
      delayMs: 42,
    }));
    const decision = await s.decide(ctx(new Error('x')));
    expect(decision).toEqual({ action: 'park', delayMs: 42 });
  });
});
