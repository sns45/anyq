/**
 * Health check routes
 */

import { Hono } from 'hono';
import { producer } from '../producer.js';
import { consumer } from '../consumer.js';

const health = new Hono();

health.get('/', async (c) => {
  const [producerHealth, consumerHealth] = await Promise.all([
    producer.healthCheck(),
    consumer.healthCheck(),
  ]);

  const healthy = producerHealth.healthy && consumerHealth.healthy;

  return c.json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    producer: producerHealth,
    consumer: consumerHealth,
  }, healthy ? 200 : 503);
});

export default health;
