/**
 * RabbitMQ adapter integration tests.
 *
 * Each test no-ops when no RabbitMQ is reachable on localhost:5672.
 * Bring one up via
 * `docker-compose -f apps/testers/rabbitmq/docker-compose.yml up rabbitmq`
 * to exercise the suite end-to-end.
 */

import { describe, test, beforeAll } from 'bun:test';
import {
  createRabbitMQAdapter,
  isRabbitMQReachable,
} from '../../src/adapters/index.js';
import { buildSuite } from './suite.js';

const adapter = createRabbitMQAdapter();
let reachable = false;
const cases = buildSuite(
  adapter,
  { exposesDLQSize: false, settleMs: 1500, topicPrefix: 'rmq-ex' },
  { reachable: () => reachable },
);

describe(`strategies × ${adapter.name}`, () => {
  beforeAll(async () => {
    reachable = await isRabbitMQReachable();
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
