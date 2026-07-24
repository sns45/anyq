/**
 * @fileoverview Cloudflare Queues adapter configuration
 * @module @anyq/cloudflare-queues/config
 */

import type { BaseQueueConfig } from '@anyq/core';
import type { Queue } from '@cloudflare/workers-types';

/**
 * Cloudflare Queues configuration
 *
 * Cloudflare Queues is push-based: producers publish through a `Queue`
 * binding declared in `wrangler.toml`/`wrangler.jsonc` and injected onto
 * `env` by the Workers runtime, while the platform delivers batches to a
 * Worker's `queue(batch, env, ctx)` export. There is no long-poll pull
 * consumer, so `queue` must be supplied on the producer; the consumer takes
 * it via {@link CloudflareQueuesConsumer.processBatch} instead of polling.
 */
export interface CloudflareQueuesConfig extends BaseQueueConfig {
  driver: 'cloudflare-queues';

  /**
   * The Queue binding for this queue, e.g. `env.MY_QUEUE`. Required for the
   * producer (used to `send`/`sendBatch`); not required for the consumer,
   * which instead receives batches via `processBatch()`.
   */
  queue?: Queue;

  /** Queue name, used for logging/metadata only. */
  queueName?: string;
}

/**
 * Default Cloudflare Queues configuration
 */
export const DEFAULT_CLOUDFLARE_QUEUES_CONFIG: Partial<CloudflareQueuesConfig> = {
  driver: 'cloudflare-queues',
};
