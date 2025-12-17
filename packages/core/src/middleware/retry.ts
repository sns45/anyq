/**
 * @fileoverview Retry middleware with exponential backoff
 * @module @anyq/core/middleware/retry
 */

import type { RetryConfig } from '../types/config.js';
import { DEFAULT_RETRY_CONFIG } from '../types/config.js';
import { AnyQError } from '../types/errors.js';

/**
 * Retry attempt information
 */
export interface RetryAttempt {
  /** Current attempt number (1-based) */
  attempt: number;
  /** Total attempts allowed */
  maxAttempts: number;
  /** Delay before this attempt in ms */
  delayMs: number;
  /** Error from previous attempt */
  error?: Error;
}

/**
 * Options for retry execution
 */
export interface RetryOptions extends Partial<RetryConfig> {
  /** Callback before each retry attempt */
  onRetry?: (attempt: RetryAttempt) => void | Promise<void>;
  /** Custom function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Abort signal to cancel retries */
  signal?: AbortSignal;
}

/**
 * Calculate delay with exponential backoff and optional jitter
 *
 * @param attempt - Current attempt number (1-based)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  config: RetryConfig
): number {
  // Calculate exponential delay: initialDelay * multiplier^(attempt-1)
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.multiplier, attempt - 1);

  // Cap at maximum delay
  let delay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter if enabled (±25% randomization)
  if (config.jitter) {
    const jitterRange = delay * 0.25;
    const jitter = Math.random() * jitterRange * 2 - jitterRange;
    delay = Math.max(0, delay + jitter);
  }

  return Math.floor(delay);
}

/**
 * Default function to check if an error is retryable
 */
export function isRetryableError(
  error: Error,
  retryablePatterns?: string[]
): boolean {
  // AnyQ errors have explicit retryable flag
  if (error instanceof AnyQError) {
    return error.retryable;
  }

  // Check error message against patterns
  if (retryablePatterns && retryablePatterns.length > 0) {
    const message = error.message.toLowerCase();
    return retryablePatterns.some((pattern) =>
      message.includes(pattern.toLowerCase())
    );
  }

  // Default retryable error patterns
  const defaultRetryablePatterns = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'socket hang up',
    'connection refused',
    'network error',
    'timeout',
    'temporarily unavailable',
    'service unavailable',
    'too many requests',
    'rate limit',
    'throttl',
  ];

  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  return defaultRetryablePatterns.some(
    (pattern) =>
      message.includes(pattern.toLowerCase()) ||
      name.includes(pattern.toLowerCase())
  );
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      reject(new Error('Aborted'));
    });
  });
}

/**
 * Execute an operation with retry logic
 *
 * @param operation - Async operation to execute
 * @param options - Retry options
 * @returns Result of the operation
 * @throws Last error if all retries exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => publishMessage(message),
 *   {
 *     maxRetries: 5,
 *     initialDelayMs: 100,
 *     onRetry: ({ attempt, delayMs }) => {
 *       console.log(`Retry attempt ${attempt} after ${delayMs}ms`);
 *     }
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options,
  };

  const { onRetry, isRetryable = isRetryableError, signal } = options;

  let lastError: Error | undefined;

  // Total attempts = 1 initial + maxRetries
  const totalAttempts = config.maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const isLastAttempt = attempt >= totalAttempts;
      const shouldRetry =
        !isLastAttempt && isRetryable(lastError, config.retryableErrors);

      if (!shouldRetry) {
        throw lastError;
      }

      // Calculate delay for next attempt
      const delayMs = calculateBackoff(attempt, config);

      // Call onRetry callback
      if (onRetry) {
        const attemptInfo: RetryAttempt = {
          attempt: attempt + 1,
          maxAttempts: totalAttempts,
          delayMs,
          error: lastError,
        };
        await onRetry(attemptInfo);
      }

      // Wait before retry
      await sleep(delayMs, signal);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError ?? new Error('Unknown error during retry');
}

/**
 * Create a retryable version of an async function
 *
 * @param fn - Function to wrap with retry logic
 * @param options - Retry options
 * @returns Wrapped function with retry logic
 *
 * @example
 * ```typescript
 * const retryablePublish = createRetryable(
 *   (msg: Message) => producer.publish(msg),
 *   { maxRetries: 3 }
 * );
 *
 * await retryablePublish(message);
 * ```
 */
export function createRetryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withRetry(() => fn(...args), options);
}
