/**
 * RabbitMQ Producer Setup
 */

import { createRabbitMQProducer, type RabbitMQProducer } from '@anyq/rabbitmq';
import { config } from './config.js';

export let producer: RabbitMQProducer<unknown>;
export let publishedCount = 0;

export async function initProducer(): Promise<void> {
  producer = createRabbitMQProducer({
    connection: {
      url: config.rabbitmq.url,
    },
    exchange: {
      name: config.rabbitmq.exchange,
      type: 'direct',
      durable: true,
    },
    routingKey: config.rabbitmq.routingKey,
    persistent: true,
  });

  await producer.connect();
  console.log(`[Producer] Connected to RabbitMQ at ${config.rabbitmq.url}`);
  console.log(`[Producer] Exchange: ${config.rabbitmq.exchange}, Routing Key: ${config.rabbitmq.routingKey}`);
}

export function incrementPublishedCount(): void {
  publishedCount++;
}

export function getPublishedCount(): number {
  return publishedCount;
}
