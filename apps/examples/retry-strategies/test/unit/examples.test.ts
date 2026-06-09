/**
 * Unit tests for the strategy examples.
 *
 * These don't spin up a producer/consumer — they just probe the
 * exported `strategy` from each example to confirm:
 *  1. The factory wired the right strategy type (by name).
 *  2. `decide()` returns the expected shape for representative contexts.
 *
 * Strategy-correctness is comprehensively covered by core's
 * `strategies.test.ts`; this file pins the examples' wiring against drift.
 */

import { describe, test, expect } from 'bun:test';
import { AnyQError, type RetryStrategyContext, type IMessage } from '@anyq/core';
import * as logAndSkip from '../../src/examples/log-and-skip.js';
import * as logAndFail from '../../src/examples/log-and-fail.js';
import * as retryThenDeadLetter from '../../src/examples/retry-then-dead-letter.js';
import * as deadLetterImmediate from '../../src/examples/dead-letter-immediate.js';
import * as backpressurePause from '../../src/examples/backpressure-pause.js';
import * as customExample from '../../src/examples/custom.js';
import { examples } from '../../src/examples/index.js';

function fakeMessage(body: { id: string; n: number }, attempt = 1): IMessage<{
  id: string;
  n: number;
}> {
  return {
    id: body.id,
    body,
    headers: {},
    timestamp: new Date(),
    deliveryAttempt: attempt,
    metadata: { provider: 'memory' },
    raw: null,
    ack: async () => undefined,
    nack: async () => undefined,
  };
}

function ctx(
  error: Error,
  body: { id: string; n: number } = { id: 'm', n: 0 },
  attempt = 1,
  maxAttempts = 3,
): RetryStrategyContext<{ id: string; n: number }> {
  return { message: fakeMessage(body, attempt), error, attempt, maxAttempts };
}

describe('examples barrel', () => {
  test('exports every expected strategy', () => {
    expect(Object.keys(examples).sort()).toEqual(
      [
        'backpressure-pause',
        'custom',
        'dead-letter-immediate',
        'log-and-fail',
        'log-and-skip',
        'retry-then-dead-letter',
      ].sort(),
    );
  });

  test('every entry exposes both strategy and run', () => {
    for (const [name, mod] of Object.entries(examples)) {
      expect(typeof mod.run).toBe('function');
      expect(mod.strategy.name).toBeDefined();
      expect(typeof mod.strategy.decide).toBe('function');
      // sanity: name kebab-cased and non-empty
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('logAndSkip example', () => {
  test('uses log-and-skip strategy and returns ack', async () => {
    expect(logAndSkip.strategy.name).toBe('log-and-skip');
    const decision = await logAndSkip.strategy.decide(ctx(new Error('boom')));
    expect(decision).toEqual({ action: 'ack' });
  });
});

describe('logAndFail example', () => {
  test('uses log-and-fail strategy and returns fail', async () => {
    expect(logAndFail.strategy.name).toBe('log-and-fail');
    const decision = await logAndFail.strategy.decide(ctx(new Error('boom')));
    expect(decision).toEqual({ action: 'fail' });
  });
});

describe('retryThenDeadLetter example', () => {
  test('retryable + under maxAttempts -> retry with positive delay', async () => {
    expect(retryThenDeadLetter.strategy.name).toBe('retry-then-dead-letter');
    const d = await retryThenDeadLetter.strategy.decide(
      ctx(new Error('ECONNRESET'), { id: 'm', n: 0 }, 1, 5),
    );
    expect(d.action).toBe('retry');
    if (d.action === 'retry') {
      expect(d.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('retryable at maxAttempts -> deadLetter', async () => {
    // Example pins maxAttempts=3 inside its strategy options so the
    // context value is irrelevant here.
    const d = await retryThenDeadLetter.strategy.decide(
      ctx(new Error('ECONNRESET'), { id: 'm', n: 0 }, 3, 99),
    );
    expect(d.action).toBe('deadLetter');
  });

  test('non-retryable AnyQError -> deadLetter immediately', async () => {
    const err = new AnyQError('bad', { retryable: false });
    const d = await retryThenDeadLetter.strategy.decide(ctx(err));
    expect(d.action).toBe('deadLetter');
  });
});

describe('deadLetterImmediate example', () => {
  test('always returns deadLetter', async () => {
    expect(deadLetterImmediate.strategy.name).toBe('dead-letter-immediate');
    const d = await deadLetterImmediate.strategy.decide(ctx(new Error('x')));
    expect(d.action).toBe('deadLetter');
  });
});

describe('backpressurePause example', () => {
  test('rate-limited error -> park with 150ms delay', async () => {
    expect(backpressurePause.strategy.name).toBe('backpressure-pause');
    const d = await backpressurePause.strategy.decide(
      ctx(new Error('HTTP 429 Too Many Requests')),
    );
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.delayMs).toBe(150);
    }
  });

  test('non rate-limited error -> requeue', async () => {
    const d = await backpressurePause.strategy.decide(ctx(new Error('other')));
    expect(d.action).toBe('requeue');
  });
});

describe('custom example', () => {
  test('even n -> deadLetter; odd n -> requeue', async () => {
    expect(customExample.strategy.name).toBe('even-deadletter-odd-requeue');
    const even = await customExample.strategy.decide(
      ctx(new Error('any'), { id: 'a', n: 2 }),
    );
    expect(even.action).toBe('deadLetter');

    const odd = await customExample.strategy.decide(
      ctx(new Error('any'), { id: 'b', n: 3 }),
    );
    expect(odd.action).toBe('requeue');
  });
});
