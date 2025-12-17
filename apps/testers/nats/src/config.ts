/**
 * NATS Tester Configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nats: {
    servers: process.env.NATS_URL ?? 'nats://localhost:4222',
    stream: process.env.NATS_STREAM ?? 'ORDERS',
    subject: process.env.NATS_SUBJECT ?? 'orders.created',
  },
} as const;
