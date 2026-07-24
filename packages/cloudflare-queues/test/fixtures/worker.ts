/**
 * @fileoverview Miniflare worker fixture exercising CloudflareQueuesConsumer
 * for round-trip integration tests. Bundled with Bun.build() before being
 * handed to Miniflare as a self-contained ES module (no npm imports allowed
 * once loaded into workerd).
 */
import { CloudflareQueuesConsumer } from '../../src/index.js';

interface TestMessageBody {
  id: string;
  label?: string;
  /** If set, nack(true) (retry) until deliveryAttempt reaches this value, then ack(). */
  failUntilAttempt?: number;
  /** If set, nack(false) (drop) on the very first delivery attempt. */
  dropOnFirstAttempt?: boolean;
}

interface Env {
  TEST_QUEUE: Queue<TestMessageBody>;
  RESULTS: KVNamespace;
}

let consumerPromise: Promise<CloudflareQueuesConsumer<TestMessageBody>> | null = null;

function getConsumer(env: Env): Promise<CloudflareQueuesConsumer<TestMessageBody>> {
  if (!consumerPromise) {
    consumerPromise = (async () => {
      const consumer = new CloudflareQueuesConsumer<TestMessageBody>({
        driver: 'cloudflare-queues',
        queueName: 'test-queue',
      });
      await consumer.connect();

      await consumer.subscribe(
        async (message) => {
          const body = message.body;
          const record = {
            id: message.id,
            body,
            attempts: message.deliveryAttempt,
            provider: message.metadata.provider,
            cloudflareQueues: message.metadata.cloudflareQueues,
          };
          await env.RESULTS.put(
            `msg:${body.id}:${message.deliveryAttempt}`,
            JSON.stringify(record)
          );

          if (body.dropOnFirstAttempt) {
            await message.nack(false);
            return;
          }

          if (
            typeof body.failUntilAttempt === 'number' &&
            message.deliveryAttempt < body.failUntilAttempt
          ) {
            await message.nack(true);
            return;
          }

          await message.ack();
        },
        { autoAck: false }
      );

      return consumer;
    })();
  }
  return consumerPromise;
}

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },

  async queue(batch: MessageBatch<TestMessageBody>, env: Env): Promise<void> {
    const consumer = await getConsumer(env);
    await consumer.processBatch(batch);
  },
};
