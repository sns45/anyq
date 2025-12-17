/**
 * @fileoverview Main entry point for memory tester
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { initProducer, disconnectProducer } from './producer.js';
import { initConsumer, disconnectConsumer } from './consumer.js';
import publishRoutes from './routes/publish.js';
import healthRoutes from './routes/health.js';
import statsRoutes from './routes/stats.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Root endpoint
app.get('/', (c) => {
  return c.json({
    service: '@anyq/tester-memory',
    version: '0.1.0',
    description: 'Memory adapter tester for anyq',
    endpoints: {
      'POST /publish': 'Publish a single order',
      'POST /publish/batch': 'Publish multiple orders',
      'POST /publish/test': 'Publish a random test order',
      'GET /health': 'Health check',
      'GET /health/ready': 'Readiness probe',
      'GET /health/live': 'Liveness probe',
      'GET /stats': 'Service statistics',
      'GET /stats/messages': 'Recent consumed messages',
    },
    documentation: 'https://github.com/anyq/anyq',
  });
});

// Mount routes
app.route('/publish', publishRoutes);
app.route('/health', healthRoutes);
app.route('/stats', statsRoutes);

// Initialize and start server
async function main() {
  console.log('🚀 Starting memory tester...');

  try {
    // Initialize producer and consumer
    await initProducer();
    await initConsumer();

    console.log(`✅ Server running at http://localhost:${config.port}`);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n🛑 Shutting down...');
      await disconnectConsumer();
      await disconnectProducer();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();

export default {
  port: config.port,
  fetch: app.fetch,
};
