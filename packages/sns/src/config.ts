/**
 * @fileoverview SNS adapter configuration
 * @module @anyq/sns/config
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * SNS connection configuration
 */
export interface SNSConnectionConfig {
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
 * SNS message attributes
 */
export interface SNSMessageAttribute {
  DataType: 'String' | 'Number' | 'Binary' | 'String.Array';
  StringValue?: string;
  BinaryValue?: Uint8Array;
}

/**
 * SNS producer options
 */
export interface SNSProducerOptions {
  /** Message group ID for FIFO topics */
  messageGroupId?: string;
  /** Message deduplication ID for FIFO topics */
  messageDeduplicationId?: string;
  /** Subject for email-type subscriptions */
  subject?: string;
}

/**
 * SNS topic configuration
 */
export interface SNSConfig extends BaseQueueConfig {
  driver: 'sns';

  /** SNS connection configuration */
  sns: SNSConnectionConfig;

  /** Topic ARN */
  topicArn: string;

  /** Whether this is a FIFO topic */
  fifo?: boolean;

  /** Producer options */
  producer?: SNSProducerOptions;
}

/**
 * Default SNS configuration
 */
export const DEFAULT_SNS_CONFIG: Partial<SNSConfig> = {
  driver: 'sns',
  sns: {
    region: 'us-east-1',
  },
  fifo: false,
  producer: {},
};
