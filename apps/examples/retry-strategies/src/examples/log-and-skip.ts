/**
 * Example: `logAndSkip`
 *
 * The strategy treats every handler failure as a success — the message is
 * acked and effectively dropped. Use when failures are non-fatal and the
 * downstream consequence of losing a single record is acceptable.
 */

import { logAndSkip } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = logAndSkip<{ id: string; n: number }>();

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-log-and-skip', opts);
}
