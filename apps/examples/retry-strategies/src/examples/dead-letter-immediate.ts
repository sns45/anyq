/**
 * Example: `deadLetterImmediate`
 *
 * No retry, no requeue — the first failure routes the message to the DLQ.
 * Use for poison messages where retrying would just consume capacity for
 * no benefit (bad payloads, schema violations, etc.).
 */

import { deadLetterImmediate } from '@anyq/core';
import { runExample, type ExampleOptions, type ExampleResult } from './shared.js';

export const strategy = deadLetterImmediate<{ id: string; n: number }>();

export async function run(opts?: ExampleOptions): Promise<ExampleResult> {
  return runExample(strategy, 'example-dead-letter-immediate', {
    handler: async () => {
      throw new Error('poison payload');
    },
    ...opts,
  });
}
