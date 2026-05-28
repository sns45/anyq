/**
 * Example: `custom`
 *
 * Wrap an arbitrary `(ctx) => RetryDecision` as a named strategy. The
 * example shows a hand-written policy: dead-letter messages with even
 * `n`, requeue the rest.
 */

import { custom, type RetryDecision } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = custom<{ id: string; n: number }>(
  'even-deadletter-odd-requeue',
  (ctx): RetryDecision => {
    if (ctx.message.body.n % 2 === 0) {
      return { action: 'deadLetter', reason: `even n=${ctx.message.body.n}` };
    }
    return { action: 'requeue' };
  },
);

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-custom', {
    messageCount: 2,
    ...opts,
  });
}
