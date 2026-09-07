/**
 * pgmq Tester - Hono Server
 * Test application for @anyq/pgmq
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { initProducer, producer } from './producer.js';
import { initConsumer, consumer } from './consumer.js';
import healthRoutes from './routes/health.js';
import publishRoutes from './routes/publish.js';
import statsRoutes from './routes/stats.js';

const app = new Hono();

// Middleware
app.use('*', logger());

// Routes
app.get('/', (c) => {
  return c.json({
    name: '@anyq/pgmq-tester',
    version: '0.0.1',
    description: 'Test application for @anyq/pgmq',
    endpoints: {
      '/': 'Service info',
      '/health': 'Health check',
      '/publish': 'POST - Publish single message',
      '/publish/batch': 'POST - Publish batch of messages',
      '/publish/test': 'POST - Publish random test message',
      '/stats': 'Get producer/consumer stats',
      '/stats/messages': 'Get recent consumed messages',
    },
    config: {
      queueName: config.pgmq.queueName,
      connectionString: config.pgmq.connectionString.replace(/:[^:@/]+@/, ':***@'),
    },
  });
});

app.route('/health', healthRoutes);
app.route('/publish', publishRoutes);
app.route('/stats', statsRoutes);

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  }, 500);
});

// Startup
async function start() {
  try {
    console.log('Starting pgmq Tester...');
    console.log(`Queue: ${config.pgmq.queueName}`);

    await initProducer();
    await initConsumer();

    console.log(`Server starting on port ${config.port}...`);
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  await Promise.all([producer.disconnect(), consumer.disconnect()]);
  process.exit(0);
}
// bun-types 1.4 only exposes Bun's own `process.on` overloads here, which hides
// the Node signal overloads; go through a minimal structural type instead.
const signals = process as unknown as { on(event: string, listener: () => void): unknown };
for (const signal of ['SIGINT', 'SIGTERM']) {
  signals.on(signal, () => {
    void shutdown();
  });
}

// Start initialization
start();

export default {
  port: config.port,
  fetch: app.fetch,
};
