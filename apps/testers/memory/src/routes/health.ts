/**
 * @fileoverview Health check routes for memory tester
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

  const producerHealthy = producer?.isConnected() ?? false;
  const consumerHealthy = consumer?.isConnected() ?? false;

  const healthy = producerHealthy && consumerHealthy;

  return c.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      components: {
        producer: {
          status: producerHealthy ? 'healthy' : 'unhealthy',
          connected: producerHealthy,
        },
        consumer: {
          status: consumerHealthy ? 'healthy' : 'unhealthy',
          connected: consumerHealthy,
          paused: consumer?.isPaused() ?? false,
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
