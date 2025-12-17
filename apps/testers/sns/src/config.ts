/**
 * SNS tester configuration
 */

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
  sns: {
    topicName: process.env.SNS_TOPIC_NAME ?? 'orders',
    topicArn: process.env.SNS_TOPIC_ARN ?? 'arn:aws:sns:us-east-1:000000000000:orders',
  },
  sqs: {
    queueName: process.env.SQS_QUEUE_NAME ?? 'orders-subscriber',
    queueUrl: process.env.SQS_QUEUE_URL ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders-subscriber',
  },
};

export type Config = typeof config;
