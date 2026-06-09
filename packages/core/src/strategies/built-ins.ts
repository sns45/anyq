/**
 * @fileoverview Built-in retry strategy factories
 * @module @anyq/core/strategies/built-ins
 */

import type { RetryConfig } from '../types/config.js';
import { DEFAULT_RETRY_CONFIG } from '../types/config.js';
import { calculateBackoff, isRetryableError } from '../middleware/retry.js';
import type {
  RetryDecision,
  RetryStrategy,
  RetryStrategyContext,
} from './types.js';
import { BACKPRESSURE_PAUSE_STRATEGY_NAME } from './types.js';

/**
 * Log the error, ack the message, move on. Message is effectively dropped.
 */
export function logAndSkip<T = unknown>(): RetryStrategy<T> {
  return {
    name: 'log-and-skip',
    decide(): RetryDecision {
      return { action: 'ack' };
    },
  };
}

/**
 * Log the error, return `{ action: 'fail' }` so the consumer loop crashes.
 */
export function logAndFail<T = unknown>(): RetryStrategy<T> {
  return {
    name: 'log-and-fail',
    decide(): RetryDecision {
      return { action: 'fail' };
    },
  };
}

/**
 * Retry in-process with exponential backoff while the error is retryable and
 * attempts remain; otherwise dead-letter.
 */
export function retryThenDeadLetter<T = unknown>(opts?: {
  maxAttempts?: number;
  backoff?: Partial<RetryConfig>;
  isRetryable?: (error: Error) => boolean;
}): RetryStrategy<T> {
  const resolvedBackoff: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...opts?.backoff,
  };
  const isRetryable = opts?.isRetryable ?? ((err: Error) => isRetryableError(err));
  const overrideMax = opts?.maxAttempts;

  return {
    name: 'retry-then-dead-letter',
    decide(ctx: RetryStrategyContext<T>): RetryDecision {
      const maxAttempts = overrideMax ?? ctx.maxAttempts;

      if (!isRetryable(ctx.error)) {
        return { action: 'deadLetter', reason: ctx.error.message };
      }
      if (ctx.attempt >= maxAttempts) {
        return { action: 'deadLetter', reason: 'max attempts exceeded' };
      }
      return {
        action: 'retry',
        delayMs: calculateBackoff(ctx.attempt, resolvedBackoff),
      };
    },
  };
}

/**
 * No retry; straight to DLQ. For poison messages.
 */
export function deadLetterImmediate<T = unknown>(): RetryStrategy<T> {
  return {
    name: 'dead-letter-immediate',
    decide(ctx: RetryStrategyContext<T>): RetryDecision {
      return { action: 'deadLetter', reason: ctx.error.message };
    },
  };
}

/**
 * On rate/quota errors, emit a `park` with a fixed delay AND signal the
 * consumer to pause for the same duration.
 *
 * The consumer pause is wired via the strategy's `name`: when
 * {@link BACKPRESSURE_PAUSE_STRATEGY_NAME} is seen, `BaseConsumer.applyStrategy`
 * calls `pause()` and schedules `resume()` after `delayMs`.
 *
 * If the error is not rate-limited, the strategy delegates to `requeue` so the
 * broker can redeliver under its own policy.
 */
export function backpressurePause<T = unknown>(opts?: {
  pauseMs?: number;
  isRateLimited?: (error: Error) => boolean;
}): RetryStrategy<T> {
  const pauseMs = opts?.pauseMs ?? 5000;
  const isRateLimited =
    opts?.isRateLimited ??
    ((err: Error) => {
      const haystack = `${err.name} ${err.message}`.toLowerCase();
      return (
        haystack.includes('rate limit') ||
        haystack.includes('too many requests') ||
        haystack.includes('throttl') ||
        haystack.includes('429') ||
        haystack.includes('quota')
      );
    });

  return {
    name: BACKPRESSURE_PAUSE_STRATEGY_NAME,
    decide(ctx: RetryStrategyContext<T>): RetryDecision {
      if (isRateLimited(ctx.error)) {
        return { action: 'park', delayMs: pauseMs };
      }
      return { action: 'requeue' };
    },
  };
}

/**
 * Wrap an arbitrary user function as a strategy.
 */
export function custom<T = unknown>(
  name: string,
  fn: (ctx: RetryStrategyContext<T>) => RetryDecision | Promise<RetryDecision>,
): RetryStrategy<T> {
  return {
    name,
    decide(ctx: RetryStrategyContext<T>): RetryDecision | Promise<RetryDecision> {
      return fn(ctx);
    },
  };
}
