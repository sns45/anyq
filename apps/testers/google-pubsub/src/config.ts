/**
 * Google Pub/Sub Tester Configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  pubsub: {
    projectId: process.env.PUBSUB_PROJECT_ID ?? 'anyq-local',
    apiEndpoint: process.env.PUBSUB_EMULATOR_HOST ?? 'localhost:8085',
    topicName: process.env.PUBSUB_TOPIC ?? 'orders',
    subscriptionName: process.env.PUBSUB_SUBSCRIPTION ?? 'orders-sub',
  },
} as const;
