/**
 * @fileoverview SNS producer implementation
 * @module @anyq/sns/producer
 */

import {
  SNSClient,
  PublishCommand,
  PublishBatchCommand,
  type PublishCommandInput,
  type PublishBatchRequestEntry,
} from '@aws-sdk/client-sns';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { SNSConfig, SNSProducerOptions } from './config.js';

/**
 * SNS producer implementation
 *
 * Publishes messages to AWS SNS topics for fan-out distribution.
 *
 * @example
 * ```typescript
 * const producer = new SNSProducer({
 *   driver: 'sns',
 *   topicArn: 'arn:aws:sns:us-east-1:123456789:my-topic',
 *   sns: { region: 'us-east-1' },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' });
 * await producer.disconnect();
 * ```
 */
export class SNSProducer<T = unknown> extends BaseProducer<T> {
  private client: SNSClient | null = null;
  private readonly topicArn: string;
  private readonly isFifo: boolean;
  private readonly producerOptions: SNSProducerOptions;

  constructor(config: SNSConfig) {
    super(config);
    this.topicArn = config.topicArn;
    this.isFifo = config.fifo ?? false;
    this.producerOptions = config.producer ?? {};
  }

  /**
   * Connect to SNS
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const snsConfig = (this.config as SNSConfig).sns;

      this.client = new SNSClient({
        region: snsConfig.region,
        endpoint: snsConfig.endpoint,
        credentials: snsConfig.accessKeyId && snsConfig.secretAccessKey
          ? {
              accessKeyId: snsConfig.accessKeyId,
              secretAccessKey: snsConfig.secretAccessKey,
            }
          : undefined,
      });

      this._connected = true;
      this.logger.info('SNS producer connected', {
        topicArn: this.topicArn,
        region: snsConfig.region,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to SNS',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from SNS
   */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.client) {
      return;
    }

    this.client.destroy();
    this.client = null;
    this._connected = false;
    this.logger.info('SNS producer disconnected');
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.client) {
      throw new ConnectionError('Producer not connected');
    }

    try {
      const serializedBody = this.serializer.serialize(body);
      const message = Buffer.isBuffer(serializedBody)
        ? serializedBody.toString('utf8')
        : serializedBody;

      const input: PublishCommandInput = {
        TopicArn: this.topicArn,
        Message: message,
        Subject: this.producerOptions.subject,
        MessageAttributes: options?.headers
          ? Object.fromEntries(
              Object.entries(options.headers).map(([key, value]) => [
                key,
                {
                  DataType: 'String',
                  StringValue: String(value),
                },
              ])
            )
          : undefined,
      };

      // FIFO topic specific attributes
      if (this.isFifo) {
        input.MessageGroupId = options?.key ?? this.producerOptions.messageGroupId ?? 'default';
        input.MessageDeduplicationId =
          this.producerOptions.messageDeduplicationId ?? `${Date.now()}-${Math.random()}`;
      }

      const command = new PublishCommand(input);
      const result = await this.client.send(command);

      const messageId = result.MessageId ?? `sns-${Date.now()}`;

      this.logger.debug('Message published', {
        messageId,
        topicArn: this.topicArn,
      });

      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages in a batch
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    if (!this.client) {
      throw new ConnectionError('Producer not connected');
    }

    // SNS batch limit is 10 messages
    const batches: Array<Array<{ body: T; options?: PublishOptions }>> = [];
    for (let i = 0; i < messages.length; i += 10) {
      batches.push(messages.slice(i, i + 10));
    }

    const allMessageIds: string[] = [];

    try {
      for (const batch of batches) {
        const entries: PublishBatchRequestEntry[] = batch.map(
          ({ body, options }, index) => {
            const serializedBody = this.serializer.serialize(body);
            const message = Buffer.isBuffer(serializedBody)
              ? serializedBody.toString('utf8')
              : serializedBody;

            const entry: PublishBatchRequestEntry = {
              Id: `msg-${index}`,
              Message: message,
              Subject: this.producerOptions.subject,
              MessageAttributes: options?.headers
                ? Object.fromEntries(
                    Object.entries(options.headers).map(([key, value]) => [
                      key,
                      {
                        DataType: 'String',
                        StringValue: String(value),
                      },
                    ])
                  )
                : undefined,
            };

            if (this.isFifo) {
              entry.MessageGroupId =
                options?.key ?? this.producerOptions.messageGroupId ?? 'default';
              entry.MessageDeduplicationId = `${Date.now()}-${index}-${Math.random()}`;
            }

            return entry;
          }
        );

        const command = new PublishBatchCommand({
          TopicArn: this.topicArn,
          PublishBatchRequestEntries: entries,
        });

        const result = await this.client.send(command);

        if (result.Successful) {
          for (const success of result.Successful) {
            allMessageIds.push(success.MessageId ?? `sns-batch-${Date.now()}`);
          }
        }

        if (result.Failed && result.Failed.length > 0) {
          this.logger.warn('Some messages failed to publish', {
            failed: result.Failed.length,
          });
        }
      }

      this.logger.debug('Batch published', {
        count: allMessageIds.length,
        topicArn: this.topicArn,
      });

      return allMessageIds;
    } catch (error) {
      throw new PublishError('Failed to publish batch', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this.client || !this._connected) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          topicArn: this.topicArn,
          fifo: this.isFifo,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        connected: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the underlying SNS client (for testing)
   */
  getClient(): SNSClient | null {
    return this.client;
  }
}
