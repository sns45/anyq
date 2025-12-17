/**
 * @fileoverview SQS adapter configuration
 * @module @anyq/sqs/config
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * SQS connection configuration
 */
export interface SQSConnectionConfig {
  /** AWS region */
  region: string;
  /** Custom endpoint URL (for LocalStack) */
  endpoint?: string;
  /** AWS access key ID */
  accessKeyId?: string;
  /** AWS secret access key */
  secretAccessKey?: string;
}

/**
 * SQS producer options
 */
export interface SQSProducerOptions {
  /** Delay seconds for message delivery (0-900) */
  delaySeconds?: number;
  /** Message group ID for FIFO queues */
  messageGroupId?: string;
  /** Message deduplication ID for FIFO queues */
  messageDeduplicationId?: string;
}

/**
 * SQS consumer options
 */
export interface SQSConsumerOptions {
  /** Maximum number of messages to receive per request (1-10). Default: 10 */
  maxNumberOfMessages?: number;
  /** Wait time in seconds for long polling (0-20). Default: 20 */
  waitTimeSeconds?: number;
  /** Visibility timeout in seconds. Default: 30 */
  visibilityTimeout?: number;
  /** Polling interval in ms when queue is empty. Default: 1000 */
  pollingInterval?: number;
}

/**
 * SQS queue configuration
 */
export interface SQSConfig extends BaseQueueConfig {
  driver: 'sqs';

  /** SQS connection configuration */
  sqs: SQSConnectionConfig;

  /** Queue URL or name */
  queueUrl: string;

  /** Whether this is a FIFO queue */
  fifo?: boolean;

  /** Producer options */
  producer?: SQSProducerOptions;

  /** Consumer options */
  consumer?: SQSConsumerOptions;

  /** Dead letter queue URL */
  deadLetterQueueUrl?: string;
}

/**
 * Default SQS configuration
 */
export const DEFAULT_SQS_CONFIG: Partial<SQSConfig> = {
  driver: 'sqs',
  sqs: {
    region: 'us-east-1',
  },
  fifo: false,
  producer: {
    delaySeconds: 0,
  },
  consumer: {
    maxNumberOfMessages: 10,
    waitTimeSeconds: 20,
    visibilityTimeout: 30,
    pollingInterval: 1000,
  },
};
