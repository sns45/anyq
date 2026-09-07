/**
 * pgmq tester configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  pgmq: {
    connectionString:
      process.env.PGMQ_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    queueName: process.env.PGMQ_QUEUE ?? 'orders',
  },
};

export type Config = typeof config;
