/**
 * Publish routes for Google Pub/Sub
 */

import { Hono } from 'hono';
import { producer, incrementPublishedCount } from '../producer.js';

interface Order {
  orderId: string;
  product: string;
  quantity: number;
  price: number;
  timestamp: string;
}

const app = new Hono();

// Publish single message
app.post('/', async (c) => {
  try {
    const body = await c.req.json<Partial<Order>>();

    const order: Order = {
      orderId: body.orderId ?? `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      product: body.product ?? 'Unknown Product',
      quantity: body.quantity ?? 1,
      price: body.price ?? 0,
      timestamp: new Date().toISOString(),
    };

    const messageId = await producer.publish(order, {
      headers: {
        'x-order-type': 'manual',
      },
    });

    incrementPublishedCount();

    return c.json({
      success: true,
      order,
      result: {
        messageId,
      },
    }, 201);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// Publish batch of messages
app.post('/batch', async (c) => {
  try {
    const { orders } = await c.req.json<{ orders: Partial<Order>[] }>();

    const fullOrders = orders.map((o, i) => ({
      orderId: o.orderId ?? `ORD-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      product: o.product ?? `Product ${i + 1}`,
      quantity: o.quantity ?? 1,
      price: o.price ?? 0,
      timestamp: new Date().toISOString(),
    }));

    const messages = fullOrders.map((order) => ({
      body: order,
      options: {
        headers: { 'x-order-type': 'batch' },
      },
    }));

    const results = await producer.publishBatch(messages);

    for (let i = 0; i < results.length; i++) {
      incrementPublishedCount();
    }

    return c.json({
      success: true,
      count: results.length,
      orders: fullOrders,
      messageIds: results,
    }, 201);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// Publish random test message
app.post('/test', async (c) => {
  const products = ['Widget', 'Gadget', 'Gizmo', 'Doohickey', 'Thingamajig'];
  const product = products[Math.floor(Math.random() * products.length)];

  const order: Order = {
    orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    product,
    quantity: Math.floor(Math.random() * 10) + 1,
    price: Math.floor(Math.random() * 10000) / 100,
    timestamp: new Date().toISOString(),
  };

  try {
    const messageId = await producer.publish(order, {
      headers: {
        'x-order-type': 'test',
        'x-generated': 'true',
      },
    });

    incrementPublishedCount();

    return c.json({
      success: true,
      order,
      result: {
        messageId,
      },
    }, 201);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
