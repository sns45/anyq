/**
 * @fileoverview SQS consumer implementation
 * @module @anyq/sqs/consumer
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type Message as SQSMessage,
} from '@aws-sdk/client-sqs';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  type IMessage,
  type MessageHeaders,
  ConnectionError,
} from '@anyq/core';
import type { SQSConfig, SQSConsumerOptions } from './config.js';

/**
 * Default subscribe options
 */
const DEFAULT_SUBSCRIBE_OPTIONS: Required<SubscribeOptions> = {
  fromBeginning: false,
  fromTimestamp: undefined as unknown as Date,
  concurrency: 1,
  autoAck: true,
  batchSize: 10,
  batchTimeout: 1000,
};

/**
 * SQS consumer implementation
 *
 * Consumes messages from AWS SQS queues using long polling.
 *
 * @example
 * ```typescript
 * const consumer = new SQSConsumer({
 *   driver: 'sqs',
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
 *   sqs: { region: 'us-east-1' },
 * });
 *
 * await consumer.connect();
 * await consumer.subscribe(async (message) => {
 *   console.log('Received:', message.body);
 *   await message.ack();
 * });
 * ```
 */
export class SQSConsumer<T = unknown> extends BaseConsumer<T> {
  private client: SQSClient | null = null;
  private readonly queueUrl: string;
  private readonly consumerOptions: SQSConsumerOptions;
  private running = false;
  private pollingPromise: Promise<void> | null = null;

  // SQS supports scheduled delivery natively via SendMessage DelaySeconds (0-900s).
  protected get supportsNativeDelay(): boolean {
    return true;
  }

  constructor(config: SQSConfig) {
    super(config);
    this.queueUrl = config.queueUrl;
    this.consumerOptions = config.consumer ?? {};
  }

  /**
   * Native park: re-publish the message to the same queue with a DelaySeconds
   * value, then delete the in-flight copy. SQS caps DelaySeconds at 900.
   */
  protected override async parkMessage(
    message: IMessage<T>,
    delayMs: number,
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('parkMessage called without a connected SQS client', {
        messageId: message.id,
      });
      await message.nack(false);
      return;
    }

    const delaySeconds = Math.min(900, Math.max(0, Math.ceil(delayMs / 1000)));
    const body = this.serializer.serialize(message.body);

    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: typeof body === 'string' ? body : body.toString(),
          DelaySeconds: delaySeconds,
        }),
      );
      // Delete the original in-flight copy so SQS doesn't redeliver after
      // the visibility timeout.
      await message.ack();
    } catch (err) {
      this.logger.error('Failed to park SQS message; returning to queue', {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await message.nack(true);
    }
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
      this.logger.info('SQS consumer connected', {
        queueUrl: this.queueUrl,
        region: sqsConfig.region,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to SQS',
        error instanceof Error ? error : undefined
      );
    }

    // No-op for SQS (native delay), but kept uniform across adapters.
    this.verifyParkPolicy();
  }

  /**
   * Disconnect from SQS
   */
  async disconnect(): Promise<void> {
    this.beginShutdown();
    if (!this._connected || !this.client) {
      return;
    }

    this.running = false;

    // Wait for polling to stop
    if (this.pollingPromise) {
      await this.pollingPromise;
      this.pollingPromise = null;
    }

    this.client.destroy();
    this.client = null;
    this._connected = false;
    this.logger.info('SQS consumer disconnected');
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.client) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    this.pollingPromise = this.poll(handler, opts);

    this.logger.info('Subscribed to queue', {
      queueUrl: this.queueUrl,
    });
  }

  /**
   * Subscribe to message batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.client) {
      throw new ConnectionError('Consumer not connected');
    }

    const opts = { ...DEFAULT_SUBSCRIBE_OPTIONS, ...options };
    this.running = true;

    this.pollingPromise = this.pollBatch(handler, opts);

    this.logger.info('Subscribed to queue (batch)', {
      queueUrl: this.queueUrl,
    });
  }

  /**
   * Poll for messages
   */
  private async poll(
    handler: MessageHandler<T>,
    opts: Required<SubscribeOptions>
  ): Promise<void> {
    while (this.running) {
      if (this._paused) {
        await this.sleep(this.consumerOptions.pollingInterval ?? 1000);
        continue;
      }

      try {
        const command = new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: Math.min(opts.concurrency, 10),
          WaitTimeSeconds: this.consumerOptions.waitTimeSeconds ?? 20,
          VisibilityTimeout: this.consumerOptions.visibilityTimeout ?? 30,
          MessageAttributeNames: ['All'],
          AttributeNames: ['All'],
        });

        const result = await this.client!.send(command);

        if (result.Messages && result.Messages.length > 0) {
          for (const sqsMessage of result.Messages) {
            if (!this.running || this._paused) break;

            const message = this.createWrappedMessage(sqsMessage, opts.autoAck);

            try {
              this.emit('message', message);
              await handler(message);

              if (opts.autoAck) {
                await message.ack();
              }
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              const result = await this.applyStrategy(message, err, () =>
                handler(message),
              );
              if (!result.handled) {
                this.logger.error('Error processing message', {
                  messageId: sqsMessage.MessageId,
                  error: err.message,
                });

                this.emit('error', err);
              }
            }
          }
        }
      } catch (error) {
        if (this.running) {
          this.logger.error('Error polling messages', {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(this.consumerOptions.pollingInterval ?? 1000);
        }
      }
    }
  }

  /**
   * Poll for message batches
   */
  private async pollBatch(
    handler: BatchMessageHandler<T>,
    opts: Required<SubscribeOptions>
  ): Promise<void> {
    while (this.running) {
      if (this._paused) {
        await this.sleep(this.consumerOptions.pollingInterval ?? 1000);
        continue;
      }

      try {
        const command = new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: Math.min(opts.batchSize, 10),
          WaitTimeSeconds: this.consumerOptions.waitTimeSeconds ?? 20,
          VisibilityTimeout: this.consumerOptions.visibilityTimeout ?? 30,
          MessageAttributeNames: ['All'],
          AttributeNames: ['All'],
        });

        const result = await this.client!.send(command);

        if (result.Messages && result.Messages.length > 0) {
          const messages: IMessage<T>[] = result.Messages.map((sqsMessage) =>
            this.createWrappedMessage(sqsMessage, opts.autoAck)
          );

          try {
            await handler(messages);

            if (opts.autoAck) {
              await Promise.all(messages.map((m) => m.ack()));
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            // SQS supports per-message ack; apply strategy per message.
            let anyUnhandled = false;
            for (const message of messages) {
              const result = await this.applyStrategy(message, err, () =>
                handler([message]),
              );
              if (!result.handled) {
                anyUnhandled = true;
              }
            }
            if (anyUnhandled) {
              this.logger.error('Error processing batch', {
                count: messages.length,
                error: err.message,
              });

              this.emit('error', err);
            }
          }
        }
      } catch (error) {
        if (this.running) {
          this.logger.error('Error polling batch', {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(this.consumerOptions.pollingInterval ?? 1000);
        }
      }
    }
  }

  /**
   * Pause consumption
   */
  async pause(): Promise<void> {
    await super.pause();
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    await super.resume();
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
          queueUrl: this.queueUrl,
          paused: this._paused,
          running: this.running,
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

  /**
   * Create a wrapped message from SQS message
   */
  private createWrappedMessage(
    sqsMessage: SQSMessage,
    _autoAck: boolean
  ): IMessage<T> {
    const body = this.serializer.deserialize(sqsMessage.Body ?? '{}');

    const headers: MessageHeaders = {};
    if (sqsMessage.MessageAttributes) {
      for (const [key, attr] of Object.entries(sqsMessage.MessageAttributes)) {
        headers[key] = attr.StringValue;
      }
    }

    const messageId = sqsMessage.MessageId ?? `sqs-${Date.now()}`;
    const receiptHandle = sqsMessage.ReceiptHandle;

    return createMessage({
      id: messageId,
      body,
      headers,
      timestamp: sqsMessage.Attributes?.SentTimestamp
        ? new Date(parseInt(sqsMessage.Attributes.SentTimestamp, 10))
        : new Date(),
      deliveryAttempt: parseInt(
        sqsMessage.Attributes?.ApproximateReceiveCount ?? '1',
        10
      ),
      metadata: {
        provider: 'sqs',
        sqs: {
          queueUrl: this.queueUrl,
          receiptHandle: receiptHandle ?? '',
          approximateReceiveCount: parseInt(
            sqsMessage.Attributes?.ApproximateReceiveCount ?? '1',
            10
          ),
          sentTimestamp: sqsMessage.Attributes?.SentTimestamp
            ? new Date(parseInt(sqsMessage.Attributes.SentTimestamp, 10))
            : new Date(),
          approximateFirstReceiveTimestamp: sqsMessage.Attributes?.ApproximateFirstReceiveTimestamp
            ? new Date(parseInt(sqsMessage.Attributes.ApproximateFirstReceiveTimestamp, 10))
            : new Date(),
          sequenceNumber: sqsMessage.Attributes?.SequenceNumber,
          messageGroupId: sqsMessage.Attributes?.MessageGroupId,
        },
      },
      raw: sqsMessage,
      onAck: async () => {
        if (receiptHandle && this.client) {
          await this.client.send(
            new DeleteMessageCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: receiptHandle,
            })
          );
        }
        this.logger.debug('Message acknowledged', { messageId });
      },
      onNack: async (requeue = true) => {
        if (receiptHandle && this.client) {
          if (requeue) {
            // Make message immediately visible again
            await this.client.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: receiptHandle,
                VisibilityTimeout: 0,
              })
            );
          } else {
            // Delete the message (or it could go to DLQ)
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: receiptHandle,
              })
            );
          }
        }
        this.logger.debug('Message nacked', { messageId, requeue });
      },
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
