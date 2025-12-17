/**
 * SQS tester configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  sqs: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    queueName: process.env.SQS_QUEUE_NAME ?? 'orders',
    queueUrl: process.env.SQS_QUEUE_URL ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders',
  },
};

export type Config = typeof config;
