/**
 * @fileoverview Stats routes for Redis Streams tester
 */

import { Hono } from 'hono';
import { getProducerStats } from '../producer.js';
import { getConsumerStats, getRecentMessages, pauseConsumer, resumeConsumer } from '../consumer.js';

const app = new Hono();

/**
 * GET /stats - Get overall service statistics
 */
app.get('/', async (c) => {
  const producerStats = getProducerStats();
  const consumerStats = getConsumerStats();

  return c.json({
    timestamp: new Date().toISOString(),
    producer: producerStats,
    consumer: {
      connected: consumerStats.connected,
      messagesConsumed: consumerStats.messagesConsumed,
      lastMessageTime: consumerStats.lastMessageTime,
      paused: consumerStats.paused,
    },
    redis: consumerStats.redis,
  });
});

/**
 * GET /stats/messages - Get recent consumed messages
 */
app.get('/messages', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '20', 10);
  const messages = getRecentMessages().slice(0, limit);

  return c.json({
    timestamp: new Date().toISOString(),
    count: messages.length,
    messages,
  });
});

/**
 * POST /stats/pause - Pause the consumer
 */
app.post('/pause', async (c) => {
  await pauseConsumer();
  return c.json({
    success: true,
    message: 'Consumer paused',
  });
});

/**
 * POST /stats/resume - Resume the consumer
 */
app.post('/resume', async (c) => {
  await resumeConsumer();
  return c.json({
    success: true,
    message: 'Consumer resumed',
  });
});

export default app;
