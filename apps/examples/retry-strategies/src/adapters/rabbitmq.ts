/**
 * RabbitMQ adapter factory for retry-strategy integration tests.
 *
 * Defaults to `amqp://guest:guest@127.0.0.1:5672/` — matches
 * `apps/testers/rabbitmq/docker-compose.yml`. The test sets up a
 * direct exchange + queue per run and tears them down on cleanup.
 */

import { RabbitMQProducer, RabbitMQConsumer } from '@anyq/rabbitmq';
import type { AdapterFactory } from '../examples/shared.js';
import { tcpReachable } from './reachable.js';

export const RABBITMQ_DEFAULT_HOST = '127.0.0.1';
export const RABBITMQ_DEFAULT_PORT = 5672;

export function isRabbitMQReachable(
  host = RABBITMQ_DEFAULT_HOST,
  port = RABBITMQ_DEFAULT_PORT,
): Promise<boolean> {
  return tcpReachable(host, port, 500);
}

export interface RabbitMQAdapterOptions {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
}

export function createRabbitMQAdapter(
  opts: RabbitMQAdapterOptions = {},
): AdapterFactory {
  const host = opts.host ?? RABBITMQ_DEFAULT_HOST;
  const port = opts.port ?? RABBITMQ_DEFAULT_PORT;
  const user = opts.user ?? 'guest';
  const pass = opts.pass ?? 'guest';
  const url = `amqp://${user}:${pass}@${host}:${port}`;

  return {
    name: 'rabbitmq',
    async create(topic, strategy) {
      const queueName = `${topic}-q`;
      const exchangeName = `${topic}-ex`;
      const routingKey = topic;

      const producer = new RabbitMQProducer<{ id: string; n: number }>({
        connection: { url },
        exchange: { name: exchangeName, type: 'direct', durable: false, autoDelete: true },
        routingKey,
        strategy,
      });
      const consumer = new RabbitMQConsumer<{ id: string; n: number }>({
        connection: { url },
        queue: { name: queueName, durable: false, exclusive: false, autoDelete: true },
        exchange: { name: exchangeName, type: 'direct', durable: false, autoDelete: true },
        bindingKey: routingKey,
        consumer: { prefetch: 1 },
        strategy,
      });

      return {
        producer,
        consumer,
        cleanup: async () => {
          const amqplib = await import('amqplib');
          try {
            const conn = await amqplib.connect(url);
            const ch = await conn.createChannel();
            try {
              await ch.deleteQueue(queueName);
            } catch {}
            try {
              await ch.deleteExchange(exchangeName);
            } catch {}
            await ch.close();
            await conn.close();
          } catch {
            // best-effort cleanup
          }
        },
      };
    },
  };
}
