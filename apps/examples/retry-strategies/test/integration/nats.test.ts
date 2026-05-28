/**
 * NATS JetStream adapter integration tests.
 *
 * Each test no-ops when no NATS server is reachable on localhost:4222.
 * Bring one up via
 * `docker-compose -f apps/testers/nats/docker-compose.yml up nats`
 * to exercise the suite end-to-end.
 */

import { describe, test, beforeAll } from 'bun:test';
import {
  createNatsAdapter,
  isNatsReachable,
} from '../../src/adapters/index.js';
import { buildSuite } from './suite.js';

const adapter = createNatsAdapter();
let reachable = false;
const cases = buildSuite(
  adapter,
  { exposesDLQSize: false, settleMs: 2000, topicPrefix: 'nats_ex' },
  { reachable: () => reachable },
);

describe(`strategies × ${adapter.name}`, () => {
  beforeAll(async () => {
    reachable = await isNatsReachable();
    if (!reachable) {
      console.warn(
        `[integration] skipping ${adapter.name} suite — broker unreachable`,
      );
    }
  });
  for (const c of cases) {
    test(c.name, c.run);
  }
});
