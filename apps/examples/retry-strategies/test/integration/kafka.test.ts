/**
 * Kafka adapter integration tests.
 *
 * Each test no-ops when no Kafka broker is reachable on localhost:9092.
 * Bring one up via
 * `docker-compose -f apps/testers/kafka/docker-compose.yml up kafka`
 * to exercise the suite end-to-end.
 */

import { describe, test, beforeAll } from 'bun:test';
import {
  createKafkaAdapter,
  isKafkaReachable,
} from '../../src/adapters/index.js';
import { buildSuite } from './suite.js';

// Kafka is the heaviest broker: a fresh consumer group needs ~3–6s to
// stabilise (group join, partition assignment, initial fetch) before the
// first message reaches the handler. settleMs alone isn't enough — bun's
// default 5s per-test timeout would expire before disconnect finishes.
const KAFKA_TEST_TIMEOUT_MS = 30000;

const adapter = createKafkaAdapter();
let reachable = false;
const cases = buildSuite(
  adapter,
  { exposesDLQSize: false, settleMs: 6000, topicPrefix: 'kafka-ex' },
  { reachable: () => reachable },
);

describe(`strategies × ${adapter.name}`, () => {
  beforeAll(async () => {
    reachable = await isKafkaReachable();
    if (!reachable) {
      console.warn(
        `[integration] skipping ${adapter.name} suite — broker unreachable`,
      );
    }
  });
  for (const c of cases) {
    test(c.name, c.run, KAFKA_TEST_TIMEOUT_MS);
  }
});
