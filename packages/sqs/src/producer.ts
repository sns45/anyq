/**
 * @fileoverview SQS producer implementation
 * @module @anyq/sqs/producer
 */

import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  type SendMessageCommandInput,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
} from '@anyq/core';
import type { SQSConfig, SQSProducerOptions } from './config.js';

/**
 * SQS producer implementation
 *
 * Publishes messages to AWS SQS queues.
 *
 * @example
 * ```typescript
 * const producer = new SQSProducer({
 *   driver: 'sqs',
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
 *   sqs: { region: 'us-east-1' },
 * });
 *
 * await producer.connect();
 * await producer.publish({ orderId: '123' });
 * await producer.disconnect();
 * ```
 */
export class SQSProducer<T = unknown> extends BaseProducer<T> {
  private client: SQSClient | null = null;
  private readonly queueUrl: string;
  private readonly isFifo: boolean;
  private readonly producerOptions: SQSProducerOptions;

  constructor(config: SQSConfig) {
    super(config);
    this.queueUrl = config.queueUrl;
    this.isFifo = config.fifo ?? false;
    this.producerOptions = config.producer ?? {};
  }

  /**
   * Connect to SQS
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const sqsConfig = (this.config as SQSConfig).sqs;

      this.client = new SQSClient({
        region: sqsConfig.region,
        endpoint: sqsConfig.endpoint,
        credentials: sqsConfig.accessKeyId && sqsConfig.secretAccessKey
          ? {
              accessKeyId: sqsConfig.accessKeyId,
              secretAccessKey: sqsConfig.secretAccessKey,
            }
          : undefined,
      });

      this._connected = true;
      this.logger.info('SQS producer connected', {
        queueUrl: this.queueUrl,
        region: sqsConfig.region,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to SQS',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from SQS
   */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.client) {
      return;
    }

    this.client.destroy();
    this.client = null;
    this._connected = false;
    this.logger.info('SQS producer disconnected');
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
      const messageBody = Buffer.isBuffer(serializedBody)
        ? serializedBody.toString('utf8')
        : serializedBody;

      const input: SendMessageCommandInput = {
        QueueUrl: this.queueUrl,
        MessageBody: messageBody,
        DelaySeconds: this.producerOptions.delaySeconds,
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

      // FIFO queue specific attributes
      if (this.isFifo) {
        input.MessageGroupId = options?.key ?? this.producerOptions.messageGroupId ?? 'default';
        input.MessageDeduplicationId =
          this.producerOptions.messageDeduplicationId ?? `${Date.now()}-${Math.random()}`;
      }

      const command = new SendMessageCommand(input);
      const result = await this.client.send(command);

      const messageId = result.MessageId ?? `sqs-${Date.now()}`;

      this.logger.debug('Message published', {
        messageId,
        queueUrl: this.queueUrl,
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

    // SQS batch limit is 10 messages
    const batches: Array<Array<{ body: T; options?: PublishOptions }>> = [];
    for (let i = 0; i < messages.length; i += 10) {
      batches.push(messages.slice(i, i + 10));
    }

    const allMessageIds: string[] = [];

    try {
      for (const batch of batches) {
        const entries: SendMessageBatchRequestEntry[] = batch.map(
          ({ body, options }, index) => {
            const serializedBody = this.serializer.serialize(body);
            const messageBody = Buffer.isBuffer(serializedBody)
              ? serializedBody.toString('utf8')
              : serializedBody;

            const entry: SendMessageBatchRequestEntry = {
              Id: `msg-${index}`,
              MessageBody: messageBody,
              DelaySeconds: this.producerOptions.delaySeconds,
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

        const command = new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: entries,
        });

        const result = await this.client.send(command);

        if (result.Successful) {
          for (const success of result.Successful) {
            allMessageIds.push(success.MessageId ?? `sqs-batch-${Date.now()}`);
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
        queueUrl: this.queueUrl,
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

      // SQS doesn't have a simple ping, so we just verify the client exists
      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          queueUrl: this.queueUrl,
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
   * Get the underlying SQS client (for testing)
   */
  getClient(): SQSClient | null {
    return this.client;
  }
}
