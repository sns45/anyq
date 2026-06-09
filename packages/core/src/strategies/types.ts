/**
 * @fileoverview Retry strategy types
 * @module @anyq/core/strategies/types
 */

import type { IMessage } from '../types/message.js';

/**
 * Decision produced by a {@link RetryStrategy} for a single failed message.
 *
 * This union is "closed for users, open for the library": future minor
 * versions MAY add variants. Custom strategies that switch on the action
 * SHOULD include a `default` branch.
 */
export type RetryDecision =
  | { action: 'ack' }
  | { action: 'retry'; delayMs: number }
  | { action: 'requeue' }
  | { action: 'deadLetter'; reason: string }
  | { action: 'park'; delayMs: number }
  | { action: 'fail' };

/**
 * Context provided to a strategy when deciding what to do about a failure.
 */
export interface RetryStrategyContext<T = unknown> {
  /** The failed message. */
  message: IMessage<T>;
  /** The error thrown by the message handler. */
  error: Error;
  /** 1-based delivery attempt count (mirrors {@link IMessage.deliveryAttempt}). */
  attempt: number;
  /** Resolved maximum attempts (see consumer maxAttempts resolution order). */
  maxAttempts: number;
}

/**
 * Pluggable per-message retry strategy.
 *
 * Implementations decide how to handle a handler failure: ack and move on,
 * retry in-process with a delay, requeue to the broker, dead-letter,
 * park (schedule for later), or fail the consumer loop.
 */
export interface RetryStrategy<T = unknown> {
  /** Stable, human-readable name for logs and signalling (e.g. backpressure pause). */
  readonly name: string;
  /**
   * Decide what to do for a given (message, error, attempt) triple.
   * May be synchronous or asynchronous.
   */
  decide(ctx: RetryStrategyContext<T>): RetryDecision | Promise<RetryDecision>;
}

/**
 * Stable name used to signal that a `park` decision should also pause/resume
 * the whole consumer. {@link applyStrategy} checks for this name.
 */
export const BACKPRESSURE_PAUSE_STRATEGY_NAME = 'backpressure-pause';
