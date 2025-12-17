/**
 * RabbitMQ Tester Configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  rabbitmq: {
    url: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
    exchange: process.env.RABBITMQ_EXCHANGE ?? 'orders',
    queue: process.env.RABBITMQ_QUEUE ?? 'orders.created',
    routingKey: process.env.RABBITMQ_ROUTING_KEY ?? 'orders.created',
  },
} as const;
