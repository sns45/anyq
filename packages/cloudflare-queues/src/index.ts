/**
 * @fileoverview Main entry point for @anyq/cloudflare-queues
 * @module @anyq/cloudflare-queues
 *
 * Cloudflare Queues adapter for anyq.
 *
 * Cloudflare Queues is push-based: a producer sends through a `Queue`
 * binding (`env.MY_QUEUE.send(...)` / `.sendBatch(...)`), and the platform
 * delivers batches to a Worker's `queue(batch, env, ctx)` export — there is
 * no long-poll pull consumer. The consumer in this package mirrors that
 * shape: `subscribe`/`subscribeBatch` register a handler, and your Worker's
 * `queue()` export forwards each delivered batch to
 * {@link CloudflareQueuesConsumer.processBatch}.
 *
 * @example
 * ```typescript
 * import { CloudflareQueuesProducer, CloudflareQueuesConsumer } from '@anyq/cloudflare-queues';
 *
 * interface Env {
 *   MY_QUEUE: Queue;
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const producer = new CloudflareQueuesProducer({
 *       driver: 'cloudflare-queues',
 *       queue: env.MY_QUEUE,
 *     });
 *     await producer.connect();
 *     await producer.publish({ orderId: '123' });
 *     return new Response('ok');
 *   },
 *
 *   async queue(batch: MessageBatch, env: Env) {
 *     const consumer = new CloudflareQueuesConsumer({ driver: 'cloudflare-queues' });
 *     await consumer.connect();
 *     await consumer.subscribe(async (message) => {
 *       console.log('Received:', message.body);
 *       await message.ack();
 *     });
 *     await consumer.processBatch(batch);
 *   },
 * };
 * ```
 */

// Config
export type { CloudflareQueuesConfig } from './config.js';
export { DEFAULT_CLOUDFLARE_QUEUES_CONFIG } from './config.js';

// Producer and Consumer
import { CloudflareQueuesProducer as _CloudflareQueuesProducer } from './producer.js';
import { CloudflareQueuesConsumer as _CloudflareQueuesConsumer } from './consumer.js';
export { CloudflareQueuesProducer } from './producer.js';
export { CloudflareQueuesConsumer } from './consumer.js';

/**
 * Create a Cloudflare Queues producer
 */
export function createCloudflareQueuesProducer<T = unknown>(
  config: Omit<import('./config.js').CloudflareQueuesConfig, 'driver'>
): _CloudflareQueuesProducer<T> {
  return new _CloudflareQueuesProducer<T>({
    driver: 'cloudflare-queues',
    ...config,
  } as import('./config.js').CloudflareQueuesConfig);
}

/**
 * Create a Cloudflare Queues consumer
 */
export function createCloudflareQueuesConsumer<T = unknown>(
  config: Omit<import('./config.js').CloudflareQueuesConfig, 'driver'>
): _CloudflareQueuesConsumer<T> {
  return new _CloudflareQueuesConsumer<T>({
    driver: 'cloudflare-queues',
    ...config,
  } as import('./config.js').CloudflareQueuesConfig);
}
