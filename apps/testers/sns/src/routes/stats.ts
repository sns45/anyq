/**
 * Stats routes
 */

import { Hono } from 'hono';
import { producer, producerStats } from '../producer.js';
import { consumer, consumerStats, consumedMessages } from '../consumer.js';
import type { Stats } from '../types.js';

const stats = new Hono();

// Get overall stats
stats.get('/', async (c) => {
  const response: Stats = {
    producer: {
      connected: producer.isConnected,
      publishedCount: producerStats.publishedCount,
      lastPublishedAt: producerStats.lastPublishedAt,
    },
    consumer: {
      connected: consumer.isConnected,
      consumedCount: consumerStats.consumedCount,
      lastConsumedAt: consumerStats.lastConsumedAt,
    },
  };

  return c.json(response);
});

// Get recent consumed messages
stats.get('/messages', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const messages = consumedMessages.slice(0, Math.min(limit, 100));

  return c.json({
    count: messages.length,
    total: consumedMessages.length,
    messages,
  });
});

export default stats;
