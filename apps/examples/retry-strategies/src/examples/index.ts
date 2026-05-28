/**
 * Strategy example barrel.
 *
 * Each entry pairs the configured `RetryStrategy` with a `run(opts?)`
 * function that exercises it end-to-end. Unit tests probe `strategy`;
 * integration tests call `run(opts)` with a per-adapter factory.
 */

import * as logAndSkip from './log-and-skip.js';
import * as logAndFail from './log-and-fail.js';
import * as retryThenDeadLetter from './retry-then-dead-letter.js';
import * as deadLetterImmediate from './dead-letter-immediate.js';
import * as backpressurePause from './backpressure-pause.js';
import * as custom from './custom.js';

export const examples = {
  'log-and-skip': logAndSkip,
  'log-and-fail': logAndFail,
  'retry-then-dead-letter': retryThenDeadLetter,
  'dead-letter-immediate': deadLetterImmediate,
  'backpressure-pause': backpressurePause,
  custom,
} as const;

export type ExampleName = keyof typeof examples;

export {
  memoryAdapter,
  runExample,
  type AdapterFactory,
  type ExampleOptions,
  type ExampleResult,
} from './shared.js';
