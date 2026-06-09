/**
 * Example: `retryThenDeadLetter`
 *
 * The reference strategy. Retries retryable errors in-process with
 * exponential backoff up to `maxAttempts`, then dead-letters. Non-retryable
 * errors go straight to the DLQ. Use as the sensible default for handlers
 * that may hit transient infrastructure failures.
 */

import { retryThenDeadLetter } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = retryThenDeadLetter<{ id: string; n: number }>({
  maxAttempts: 3,
  backoff: { initialDelayMs: 5, maxDelayMs: 20, jitter: false },
});

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-retry-then-dl', opts);
}
