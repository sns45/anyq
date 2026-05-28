/**
 * Redis Streams adapter integration tests.
 *
 * Each test no-ops when no Redis is reachable on localhost:6379.
 * Bring one up via
 * `docker-compose -f apps/testers/redis-streams/docker-compose.yml up redis`
 * to exercise the suite end-to-end.
 */

import { describe, test, beforeAll } from 'bun:test';
import {
  createRedisStreamsAdapter,
  isRedisReachable,
} from '../../src/adapters/index.js';
import { buildSuite } from './suite.js';

const adapter = createRedisStreamsAdapter();
let reachable = false;
const cases = buildSuite(
  adapter,
  { exposesDLQSize: false, settleMs: 1500, topicPrefix: 'rs-ex' },
  { reachable: () => reachable },
);

describe(`strategies × ${adapter.name}`, () => {
  beforeAll(async () => {
    reachable = await isRedisReachable();
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
