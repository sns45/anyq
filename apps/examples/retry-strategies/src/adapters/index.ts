/**
 * Adapter factory barrel.
 *
 * The retry-strategy examples are adapter-agnostic. This barrel collects
 * the broker-specific factories so integration tests can iterate over
 * them uniformly.
 */

export { tcpReachable } from './reachable.js';

export {
  createRedisStreamsAdapter,
  isRedisReachable,
  REDIS_DEFAULT_HOST,
  REDIS_DEFAULT_PORT,
} from './redis-streams.js';

export {
  createRabbitMQAdapter,
  isRabbitMQReachable,
  RABBITMQ_DEFAULT_HOST,
  RABBITMQ_DEFAULT_PORT,
} from './rabbitmq.js';

export {
  createNatsAdapter,
  isNatsReachable,
  NATS_DEFAULT_HOST,
  NATS_DEFAULT_PORT,
} from './nats.js';

export {
  createKafkaAdapter,
  isKafkaReachable,
  KAFKA_DEFAULT_HOST,
  KAFKA_DEFAULT_PORT,
} from './kafka.js';
