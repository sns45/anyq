/**
 * Health check routes
 */

import { Hono } from 'hono';
import { producer } from '../producer.js';
import { consumer } from '../consumer.js';

const app = new Hono();

app.get('/', (c) => {
  const producerConnected = producer.isConnected();
  const consumerConnected = consumer.isConnected();
  const healthy = producerConnected && consumerConnected;

  return c.json({
    status: healthy ? 'healthy' : 'unhealthy',
    producer: {
      connected: producerConnected,
    },
    consumer: {
      connected: consumerConnected,
      paused: consumer.isPaused(),
    },
    timestamp: new Date().toISOString(),
  }, healthy ? 200 : 503);
});

export default app;
