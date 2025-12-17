/**
 * @fileoverview Stats routes for memory tester
 */

import { Hono } from 'hono';
import { getProducerStats } from '../producer.js';
import { getConsumerStats, getRecentMessages } from '../consumer.js';

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
    },
    queue: consumerStats.queue,
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

export default app;
