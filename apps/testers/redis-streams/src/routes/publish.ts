/**
 * @fileoverview Publish routes for Redis Streams tester
 */

import { Hono } from 'hono';
import { publishMessage, publishBatch } from '../producer.js';
import type { OrderMessage, OrderItem } from '../types.js';

const app = new Hono();

/**
 * POST /publish - Publish a single order
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json<OrderMessage>();

    if (!body.orderId || !body.customerId) {
      return c.json({ error: 'Missing required fields: orderId, customerId' }, 400);
    }

    const messageId = await publishMessage(body);

    return c.json({
      success: true,
      messageId,
      order: body,
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
});

/**
 * POST /publish/batch - Publish multiple orders
 */
app.post('/batch', async (c) => {
  try {
    const body = await c.req.json<{ orders: OrderMessage[] }>();

    if (!body.orders || !Array.isArray(body.orders)) {
      return c.json({ error: 'Missing required field: orders (array)' }, 400);
    }

    const messageIds = await publishBatch(body.orders);

    return c.json({
      success: true,
      count: messageIds.length,
      messageIds,
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
});

/**
 * POST /publish/test - Publish a random test order
 */
app.post('/test', async (c) => {
  try {
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `CUST-${Math.floor(Math.random() * 1000)}`;

    const items: OrderItem[] = Array.from(
      { length: Math.floor(Math.random() * 5) + 1 },
      (_, i) => ({
        productId: `PROD-${1000 + i}`,
        name: `Test Product ${i + 1}`,
        quantity: Math.floor(Math.random() * 5) + 1,
        price: parseFloat((Math.random() * 100 + 10).toFixed(2)),
      })
    );

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    const order: OrderMessage = {
      orderId,
      customerId,
      items,
      total: parseFloat(total.toFixed(2)),
      createdAt: new Date().toISOString(),
    };

    const messageId = await publishMessage(order);

    return c.json({
      success: true,
      messageId,
      order,
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
});

export default app;
