/**
 * @fileoverview Backoff calculation utilities for anyq
 * @module @anyq/core/utils/backoff
 */

import { DEFAULT_RETRY_CONFIG } from '../types/config.js';

/**
 * Backoff strategy type
 */
export type BackoffStrategy = 'exponential' | 'linear' | 'constant' | 'fibonacci';

/**
 * Options for backoff calculation
 */
export interface BackoffOptions {
  /** Backoff strategy. Default: 'exponential' */
  strategy?: BackoffStrategy;
  /** Initial delay in milliseconds */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff */
  multiplier?: number;
  /** Add jitter to prevent thundering herd */
  jitter?: boolean;
  /** Jitter factor (0-1). Default: 0.25 */
  jitterFactor?: number;
}

/**
 * Calculate exponential backoff delay
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Backoff options
 * @returns Delay in milliseconds
 */
export function exponentialBackoff(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    multiplier = DEFAULT_RETRY_CONFIG.multiplier,
    jitter = DEFAULT_RETRY_CONFIG.jitter,
    jitterFactor = 0.25,
  } = options;

  // Calculate base delay: initialDelay * multiplier^(attempt-1)
  let delay = initialDelayMs * Math.pow(multiplier, attempt - 1);

  // Cap at maximum
  delay = Math.min(delay, maxDelayMs);

  // Apply jitter
  if (jitter) {
    delay = applyJitter(delay, jitterFactor);
  }

  return Math.floor(delay);
}

/**
 * Calculate linear backoff delay
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Backoff options
 * @returns Delay in milliseconds
 */
export function linearBackoff(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    multiplier = 1000, // Increment per attempt
    jitter = DEFAULT_RETRY_CONFIG.jitter,
    jitterFactor = 0.25,
  } = options;

  // Calculate linear delay: initialDelay + (attempt - 1) * increment
  let delay = initialDelayMs + (attempt - 1) * multiplier;

  // Cap at maximum
  delay = Math.min(delay, maxDelayMs);

  // Apply jitter
  if (jitter) {
    delay = applyJitter(delay, jitterFactor);
  }

  return Math.floor(delay);
}

/**
 * Calculate constant backoff delay
 *
 * @param _attempt - Current attempt number (unused)
 * @param options - Backoff options
 * @returns Delay in milliseconds
 */
export function constantBackoff(
  _attempt: number,
  options: BackoffOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    jitter = DEFAULT_RETRY_CONFIG.jitter,
    jitterFactor = 0.25,
  } = options;

  let delay = initialDelayMs;

  // Apply jitter
  if (jitter) {
    delay = applyJitter(delay, jitterFactor);
  }

  return Math.floor(delay);
}

/**
 * Calculate Fibonacci backoff delay
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Backoff options
 * @returns Delay in milliseconds
 */
export function fibonacciBackoff(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitter = DEFAULT_RETRY_CONFIG.jitter,
    jitterFactor = 0.25,
  } = options;

  // Calculate Fibonacci number for the attempt
  const fib = fibonacci(attempt);

  // Scale by initial delay
  let delay = initialDelayMs * fib;

  // Cap at maximum
  delay = Math.min(delay, maxDelayMs);

  // Apply jitter
  if (jitter) {
    delay = applyJitter(delay, jitterFactor);
  }

  return Math.floor(delay);
}

/**
 * Calculate Fibonacci number
 */
function fibonacci(n: number): number {
  if (n <= 1) return 1;

  let prev = 1;
  let curr = 1;

  for (let i = 2; i < n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }

  return curr;
}

/**
 * Apply jitter to a delay value
 *
 * @param delay - Base delay in milliseconds
 * @param factor - Jitter factor (0-1)
 * @returns Delay with jitter applied
 */
export function applyJitter(delay: number, factor: number = 0.25): number {
  const jitterRange = delay * factor;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;
  return Math.max(0, delay + jitter);
}

/**
 * Calculate backoff delay using specified strategy
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Backoff options
 * @returns Delay in milliseconds
 */
export function calculateDelay(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const strategy = options.strategy ?? 'exponential';

  switch (strategy) {
    case 'exponential':
      return exponentialBackoff(attempt, options);
    case 'linear':
      return linearBackoff(attempt, options);
    case 'constant':
      return constantBackoff(attempt, options);
    case 'fibonacci':
      return fibonacciBackoff(attempt, options);
    default:
      return exponentialBackoff(attempt, options);
  }
}

/**
 * Create a backoff iterator for sequential attempts
 *
 * @param options - Backoff options
 * @param maxAttempts - Maximum number of attempts
 * @returns Generator yielding delays for each attempt
 *
 * @example
 * ```typescript
 * for (const delay of backoffIterator({ strategy: 'exponential' }, 5)) {
 *   console.log(`Wait ${delay}ms before next attempt`);
 *   await sleep(delay);
 * }
 * ```
 */
export function* backoffIterator(
  options: BackoffOptions = {},
  maxAttempts: number = 10
): Generator<number, void, unknown> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    yield calculateDelay(attempt, options);
  }
}
