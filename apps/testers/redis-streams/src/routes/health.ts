/**
 * @fileoverview Health check routes for Redis Streams tester
 */

import { Hono } from 'hono';
import { getProducer } from '../producer.js';
import { getConsumer } from '../consumer.js';

const app = new Hono();

/**
 * GET /health - Health check endpoint
 */
app.get('/', async (c) => {
  const producer = getProducer();
  const consumer = getConsumer();

  let producerHealthy = false;
  let consumerHealthy = false;
  let producerDetails = {};
  let consumerDetails = {};

  if (producer) {
    const health = await producer.healthCheck();
    producerHealthy = health.healthy;
    producerDetails = health.details ?? {};
  }

  if (consumer) {
    const health = await consumer.healthCheck();
    consumerHealthy = health.healthy;
    consumerDetails = health.details ?? {};
  }

  const healthy = producerHealthy && consumerHealthy;

  return c.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      components: {
        producer: {
          status: producerHealthy ? 'healthy' : 'unhealthy',
          connected: producerHealthy,
          details: producerDetails,
        },
        consumer: {
          status: consumerHealthy ? 'healthy' : 'unhealthy',
          connected: consumerHealthy,
          details: consumerDetails,
        },
      },
    },
    healthy ? 200 : 503
  );
});

/**
 * GET /health/ready - Readiness probe
 */
app.get('/ready', async (c) => {
  const producer = getProducer();
  const consumer = getConsumer();

  const ready = (producer?.isConnected() ?? false) && (consumer?.isConnected() ?? false);

  return c.json(
    {
      ready,
      timestamp: new Date().toISOString(),
    },
    ready ? 200 : 503
  );
});

/**
 * GET /health/live - Liveness probe
 */
app.get('/live', async (c) => {
  return c.json({
    alive: true,
    timestamp: new Date().toISOString(),
  });
});

export default app;
