/**
 * Stats routes
 */

import { Hono } from 'hono';
import { getPublishedCount } from '../producer.js';
import { getConsumedCount, getRecentMessages } from '../consumer.js';

const app = new Hono();

app.get('/', (c) => {
  return c.json({
    producer: {
      publishedCount: getPublishedCount(),
    },
    consumer: {
      consumedCount: getConsumedCount(),
      recentMessagesCount: getRecentMessages().length,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/messages', (c) => {
  const messages = getRecentMessages();
  return c.json({
    count: messages.length,
    messages: messages.slice(-20), // Last 20 messages
  });
});

export default app;
