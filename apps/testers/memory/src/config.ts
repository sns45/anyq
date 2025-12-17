/**
 * @fileoverview Configuration for memory tester
 */

import type { MemoryQueueConfig } from '@anyq/memory';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  queueName: process.env.QUEUE_NAME ?? 'test-orders',
};

export const queueConfig: MemoryQueueConfig = {
  driver: 'memory',
  queueName: config.queueName,
  maxMessages: 10000,
  deadLetterQueue: {
    enabled: true,
    destination: `${config.queueName}-dlq`,
    maxDeliveryAttempts: 3,
    includeError: true,
  },
  logging: {
    enabled: true,
    level: 'info',
  },
};
