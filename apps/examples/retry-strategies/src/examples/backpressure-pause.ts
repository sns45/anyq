/**
 * Example: `backpressurePause`
 *
 * On rate/quota errors (HTTP 429, "rate limit", "throttle"...) the strategy
 * returns `{ action: 'park' }` and `applyStrategy` additionally pauses the
 * whole consumer for `pauseMs`, scheduling a `resume()` after the delay.
 *
 * The example uses a handler that always throws a 429 so we can observe
 * the consumer entering the paused state during the run.
 */

import { backpressurePause } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = backpressurePause<{ id: string; n: number }>({
  pauseMs: 150,
});

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-backpressure-pause', {
    handler: async () => {
      throw new Error('HTTP 429 Too Many Requests');
    },
    // Snapshot before the scheduled resume() fires so we observe paused=true.
    settleMs: 50,
    ...opts,
  });
}
