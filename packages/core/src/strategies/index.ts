/**
 * @fileoverview Pluggable retry strategies for @anyq/core
 * @module @anyq/core/strategies
 *
 * Strategies let consumers decide, per-error, what to do with a failed
 * message: ack, retry in-process, requeue, dead-letter, park (scheduled
 * retry), or fail the consumer loop.
 *
 * The feature is opt-in: when {@link BaseQueueConfig.strategy} is omitted,
 * each adapter falls back to its legacy catch-block behaviour.
 *
 * @example
 * ```typescript
 * import { retryThenDeadLetter, MemoryConsumer } from '@anyq/core';
 *
 * const consumer = new MemoryConsumer({
 *   driver: 'memory',
 *   queueName: 'orders',
 *   strategy: retryThenDeadLetter({ maxAttempts: 5 }),
 * });
 * ```
 */

export type {
  RetryDecision,
  RetryStrategy,
  RetryStrategyContext,
} from './types.js';
export { BACKPRESSURE_PAUSE_STRATEGY_NAME } from './types.js';

export {
  logAndSkip,
  logAndFail,
  retryThenDeadLetter,
  deadLetterImmediate,
  backpressurePause,
  custom,
} from './built-ins.js';
