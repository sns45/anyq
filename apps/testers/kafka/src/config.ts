/**
 * Kafka tester configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID ?? 'anyq-kafka-tester',
    topic: process.env.KAFKA_TOPIC ?? 'orders',
    groupId: process.env.KAFKA_GROUP_ID ?? 'order-processors',
  },
};

export type Config = typeof config;
