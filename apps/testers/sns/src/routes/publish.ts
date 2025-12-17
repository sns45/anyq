/**
 * Publish routes
 */

import { Hono } from 'hono';
import { producer, producerStats } from '../producer.js';
import type { Order } from '../types.js';

const publish = new Hono();

// Publish single message
publish.post('/', async (c) => {
  const body = await c.req.json<Order>();

  const messageId = await producer.publish(body, {
    headers: {
      'x-source': 'sns-tester',
      'x-timestamp': new Date().toISOString(),
    },
  });

  producerStats.publishedCount++;
  producerStats.lastPublishedAt = new Date();

  return c.json({
    success: true,
    messageId,
    order: body,
  }, 201);
});

// Publish batch
publish.post('/batch', async (c) => {
  const orders = await c.req.json<Order[]>();

  const messages = orders.map((order) => ({
    body: order,
    options: {
      headers: {
        'x-source': 'sns-tester',
        'x-timestamp': new Date().toISOString(),
      },
    },
  }));

  const messageIds = await producer.publishBatch(messages);

  producerStats.publishedCount += orders.length;
  producerStats.lastPublishedAt = new Date();

  return c.json({
    success: true,
    count: messageIds.length,
    messageIds,
  }, 201);
});

// Publish test order
publish.post('/test', async (c) => {
  const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  const testOrder: Order = {
    orderId,
    customerId: `CUST-${Math.floor(Math.random() * 1000)}`,
    items: [
      {
        productId: `PROD-${Math.floor(Math.random() * 100)}`,
        name: `Test Product ${Math.floor(Math.random() * 10)}`,
        quantity: Math.floor(Math.random() * 5) + 1,
        price: parseFloat((Math.random() * 100).toFixed(2)),
      },
    ],
    total: parseFloat((Math.random() * 500).toFixed(2)),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const messageId = await producer.publish(testOrder, {
    headers: {
      'x-source': 'sns-tester',
      'x-test': 'true',
    },
  });

  producerStats.publishedCount++;
  producerStats.lastPublishedAt = new Date();

  return c.json({
    success: true,
    messageId,
    order: testOrder,
  }, 201);
});

export default publish;
