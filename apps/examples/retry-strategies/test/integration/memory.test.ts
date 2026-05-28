/**
 * Memory adapter integration tests.
 * Always runs — the memory adapter needs no infra.
 */

import { describe, test } from 'bun:test';
import { memoryAdapter } from '../../src/examples/shared.js';
import { buildSuite } from './suite.js';

const cases = buildSuite(
  memoryAdapter,
  { exposesDLQSize: true, settleMs: 250, topicPrefix: 'mem' },
  { reachable: () => true },
);

describe(`strategies × ${memoryAdapter.name}`, () => {
  for (const c of cases) {
    test(c.name, c.run);
  }
});
