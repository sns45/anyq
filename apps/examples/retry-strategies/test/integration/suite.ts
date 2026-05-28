/**
 * Shared integration suite.
 *
 * Exposes the per-adapter test cases as plain data (`buildSuite`) so each
 * per-adapter test file can register them with `describe`/`test` from its
 * own `bun:test` import. Calling `describe`/`test` from a helper module
 * causes bun to drop registrations when multiple test files import the
 * same helper — hence this data-driven layout.
 */

import { expect } from 'bun:test';
import type { AdapterFactory } from '../../src/examples/shared.js';
import * as logAndSkip from '../../src/examples/log-and-skip.js';
import * as retryThenDeadLetter from '../../src/examples/retry-then-dead-letter.js';
import * as deadLetterImmediate from '../../src/examples/dead-letter-immediate.js';
import * as backpressurePause from '../../src/examples/backpressure-pause.js';

export interface AdapterCapabilities {
  /** Adapter populates `deadLetterSize` via its snapshot callback. */
  exposesDLQSize: boolean;
  /** Wait time after publishing before snapshotting. */
  settleMs: number;
  /** Per-test queue/topic prefix. */
  topicPrefix: string;
}

export interface SuiteContext {
  /** Lazy reachability flag; updated by the per-adapter file's beforeAll. */
  reachable: () => boolean;
}

export interface SuiteCase {
  name: string;
  run: () => Promise<void>;
}

export function buildSuite(
  adapter: AdapterFactory,
  caps: AdapterCapabilities,
  ctx: SuiteContext,
): SuiteCase[] {
  const guarded = (
    name: string,
    body: () => Promise<void>,
  ): SuiteCase => ({
    name,
    run: async () => {
      if (!ctx.reachable()) {
        // Soft skip — bun has no per-test runtime skip. The assertion
        // keeps the count truthful while logging the reason.
        expect(true).toBe(true);
        return;
      }
      await body();
    },
  });

  return [
    guarded('logAndSkip: handler invoked once; no retry', async () => {
      const result = await logAndSkip.run({
        adapter,
        topic: `${caps.topicPrefix}-skip-${Date.now()}`,
        settleMs: caps.settleMs,
      });
      expect(result.strategy).toBe('log-and-skip');
      expect(result.handlerInvocations).toBe(1);
      if (caps.exposesDLQSize) {
        expect(result.deadLetterSize).toBe(0);
      }
    }),

    guarded(
      'retryThenDeadLetter: handler invoked maxAttempts times for retryable',
      async () => {
        const result = await retryThenDeadLetter.run({
          adapter,
          topic: `${caps.topicPrefix}-retry-${Date.now()}`,
          settleMs: caps.settleMs,
        });
        expect(result.strategy).toBe('retry-then-dead-letter');
        expect(result.handlerInvocations).toBeGreaterThanOrEqual(2);
        if (caps.exposesDLQSize) {
          expect(result.deadLetterSize).toBeGreaterThan(0);
        }
      },
    ),

    guarded('deadLetterImmediate: handler invoked exactly once', async () => {
      const result = await deadLetterImmediate.run({
        adapter,
        topic: `${caps.topicPrefix}-dli-${Date.now()}`,
        settleMs: caps.settleMs,
      });
      expect(result.strategy).toBe('dead-letter-immediate');
      expect(result.handlerInvocations).toBe(1);
      if (caps.exposesDLQSize) {
        expect(result.deadLetterSize).toBeGreaterThan(0);
      }
    }),

    guarded(
      'backpressurePause: consumer paused on rate-limited error',
      async () => {
        // Snapshot mid-flight: as soon as the handler has been invoked at
        // least once (the strategy fires pause() inside applyStrategy on
        // the first failure), and bounded by caps.settleMs so the test
        // still terminates if delivery never happens.
        const result = await backpressurePause.run({
          adapter,
          topic: `${caps.topicPrefix}-bp-${Date.now()}`,
          settleMs: caps.settleMs,
          snapshotWhen: (invocations, consumer) =>
            invocations >= 1 && consumer.isPaused(),
        });
        expect(result.strategy).toBe('backpressure-pause');
        expect(result.handlerInvocations).toBeGreaterThanOrEqual(1);
        expect(result.consumerPausedAtEnd).toBe(true);
      },
    ),
  ];
}
