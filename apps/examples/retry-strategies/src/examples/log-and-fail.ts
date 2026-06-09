/**
 * Example: `logAndFail`
 *
 * The strategy returns `{ action: 'fail' }`, which causes `applyStrategy`
 * to rethrow the original error. Use when failure should escalate up the
 * consumer loop (typically a process supervisor restarts the consumer).
 *
 * The example uses `messageCount: 1` because once the consumer's catch
 * rethrows, the loop is poisoned for that invocation; we only need a
 * single message to demonstrate it.
 */

import { logAndFail } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = logAndFail<{ id: string; n: number }>();

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-log-and-fail', {
    messageCount: 1,
    ...opts,
  });
}
