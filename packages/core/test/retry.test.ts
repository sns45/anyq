/**
 * @fileoverview Retry middleware tests
 */

import { describe, test, expect } from 'bun:test';
import {
  withRetry,
  createRetryable,
  calculateBackoff,
  isRetryableError,
  AnyQError,
} from '../src/index.js';

describe('withRetry', () => {
  test('should return result on success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  test('should retry on failure and succeed', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('ECONNREFUSED');
        }
        return 'success after retries';
      },
      { maxRetries: 3, initialDelayMs: 10 }
    );

    expect(result).toBe('success after retries');
    expect(attempts).toBe(3);
  });

  test('should throw after max retries exhausted', async () => {
    let attempts = 0;

    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error('ECONNREFUSED');
        },
        { maxRetries: 2, initialDelayMs: 10 }
      );
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('ECONNREFUSED');
    }

    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  test('should not retry non-retryable errors', async () => {
    let attempts = 0;

    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error('Invalid input');
        },
        {
          maxRetries: 3,
          initialDelayMs: 10,
          isRetryable: () => false,
        }
      );
    } catch {
      // Expected
    }

    expect(attempts).toBe(1); // No retries
  });

  test('should call onRetry callback', async () => {
    const retryAttempts: number[] = [];

    try {
      await withRetry(
        async () => {
          throw new Error('ETIMEDOUT');
        },
        {
          maxRetries: 2,
          initialDelayMs: 10,
          onRetry: (attempt) => {
            retryAttempts.push(attempt.attempt);
          },
        }
      );
    } catch {
      // Expected
    }

    expect(retryAttempts).toEqual([2, 3]);
  });

  test('should respect abort signal', async () => {
    const controller = new AbortController();

    // Abort after short delay
    setTimeout(() => controller.abort(), 50);

    try {
      await withRetry(
        async () => {
          throw new Error('ECONNREFUSED');
        },
        {
          maxRetries: 10,
          initialDelayMs: 100,
          signal: controller.signal,
        }
      );
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect((error as Error).message).toBe('Aborted');
    }
  });
});

describe('createRetryable', () => {
  test('should create a retryable function', async () => {
    let attempts = 0;

    const retryableFn = createRetryable(
      async (x: number) => {
        attempts++;
        if (attempts < 2) {
          throw new Error('ECONNREFUSED');
        }
        return x * 2;
      },
      { maxRetries: 2, initialDelayMs: 10 }
    );

    const result = await retryableFn(5);
    expect(result).toBe(10);
    expect(attempts).toBe(2);
  });
});

describe('calculateBackoff', () => {
  test('should calculate exponential backoff', () => {
    const config = {
      initialDelayMs: 100,
      maxDelayMs: 10000,
      multiplier: 2,
      jitter: false,
      maxRetries: 5,
    };

    expect(calculateBackoff(1, config)).toBe(100);
    expect(calculateBackoff(2, config)).toBe(200);
    expect(calculateBackoff(3, config)).toBe(400);
    expect(calculateBackoff(4, config)).toBe(800);
  });

  test('should cap at maxDelayMs', () => {
    const config = {
      initialDelayMs: 100,
      maxDelayMs: 500,
      multiplier: 2,
      jitter: false,
      maxRetries: 5,
    };

    expect(calculateBackoff(10, config)).toBe(500);
  });

  test('should add jitter when enabled', () => {
    const config = {
      initialDelayMs: 100,
      maxDelayMs: 10000,
      multiplier: 2,
      jitter: true,
      maxRetries: 5,
    };

    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      delays.add(calculateBackoff(1, config));
    }

    // With jitter, we should get varied delays
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('isRetryableError', () => {
  test('should detect retryable network errors', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('connection refused'))).toBe(true);
  });

  test('should respect AnyQError retryable flag', () => {
    const retryable = new AnyQError('test', { retryable: true });
    const nonRetryable = new AnyQError('test', { retryable: false });

    expect(isRetryableError(retryable)).toBe(true);
    expect(isRetryableError(nonRetryable)).toBe(false);
  });

  test('should check custom patterns', () => {
    expect(
      isRetryableError(new Error('custom error'), ['custom error'])
    ).toBe(true);
    expect(
      isRetryableError(new Error('other error'), ['custom error'])
    ).toBe(false);
  });
});
