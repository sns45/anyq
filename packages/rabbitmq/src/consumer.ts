/**
 * RabbitMQ Consumer Implementation
 */

import amqp, { type ChannelModel, type Channel, type ConsumeMessage } from 'amqplib';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  ConnectionError,
} from '@anyq/core';
import type { RabbitMQConsumerConfig } from './config.js';
import { RABBITMQ_DEFAULTS } from './config.js';

/**
 * RabbitMQ Consumer
 *
 * Consumes messages from RabbitMQ queues
 */
export class RabbitMQConsumer<T = unknown> extends BaseConsumer<T> {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private readonly rabbitConfig: RabbitMQConsumerConfig;

  constructor(config: RabbitMQConsumerConfig) {
    super(config);
    this.rabbitConfig = {
      ...config,
      connection: {
        ...RABBITMQ_DEFAULTS.connection,
        ...config.connection,
      },
      queue: {
        ...RABBITMQ_DEFAULTS.queue,
        ...config.queue,
      },
      consumer: {
        ...RABBITMQ_DEFAULTS.consumer,
        ...config.consumer,
      },
    };
  }

  /**
   * Connect to RabbitMQ
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const { connection: connConfig, queue: queueConfig, exchange, bindingKey } = this.rabbitConfig;

      // Build connection URL
      let url = connConfig.url;
      if (connConfig.vhost) {
        url = `${url}/${encodeURIComponent(connConfig.vhost)}`;
      }

      // Connect
      this.connection = await amqp.connect(url, {
        heartbeat: connConfig.heartbeat,
        timeout: connConfig.connectionTimeout,
        channelMax: connConfig.channelMax,
        frameMax: connConfig.frameMax,
      });

      // Create channel
      this.channel = await this.connection.createChannel();

      // Set prefetch
      await this.channel.prefetch(this.rabbitConfig.consumer?.prefetch ?? 10);

      // Assert queue
      const queueArgs: Record<string, unknown> = {};
      if (queueConfig.deadLetterExchange) {
        queueArgs['x-dead-letter-exchange'] = queueConfig.deadLetterExchange;
        if (queueConfig.deadLetterRoutingKey) {
          queueArgs['x-dead-letter-routing-key'] = queueConfig.deadLetterRoutingKey;
        }
      }
      if (queueConfig.messageTtl) {
        queueArgs['x-message-ttl'] = queueConfig.messageTtl;
      }
      if (queueConfig.maxLength) {
        queueArgs['x-max-length'] = queueConfig.maxLength;
      }
      if (queueConfig.maxLengthBytes) {
        queueArgs['x-max-length-bytes'] = queueConfig.maxLengthBytes;
      }

      await this.channel.assertQueue(queueConfig.name, {
        durable: queueConfig.durable,
        exclusive: queueConfig.exclusive,
        autoDelete: queueConfig.autoDelete,
        arguments: { ...queueArgs, ...queueConfig.arguments },
      });

      // If exchange is specified, assert and bind
      if (exchange) {
        await this.channel.assertExchange(exchange.name, exchange.type, {
          durable: exchange.durable ?? true,
          autoDelete: exchange.autoDelete ?? false,
          internal: exchange.internal,
          arguments: exchange.arguments,
        });

        await this.channel.bindQueue(
          queueConfig.name,
          exchange.name,
          bindingKey ?? ''
        );
      }

      // Handle connection errors
      this.connection.on('error', (err) => {
        this.logger.error('Connection error', { error: err.message });
        this._connected = false;
      });

      this.connection.on('close', () => {
        this.logger.warn('Connection closed');
        this._connected = false;
      });

      this._connected = true;
      this.logger.info('RabbitMQ consumer connected', {
        url: connConfig.url,
        queue: queueConfig.name,
        exchange: exchange?.name,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to RabbitMQ',
        error instanceof Error ? error : undefined
      );
    }

    // After a successful connect, enforce the park-downgrade policy. RabbitMQ
    // has no native delayed redelivery in this release, so a park-capable
    // strategy downgrades to a blocking in-process retry (warn, or throw when
    // allowParkDowngrade === false). Kept outside the try so a thrown
    // ConfigurationError is not masked as a ConnectionError.
    this.verifyParkPolicy();
  }

  /**
   * Disconnect from RabbitMQ
   */
  async disconnect(): Promise<void> {
    this.beginShutdown();
    try {
      if (this.channel && this.consumerTag) {
        await this.channel.cancel(this.consumerTag);
        this.consumerTag = null;
      }

      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      this._connected = false;
      this.logger.info('RabbitMQ consumer disconnected');
    } catch (error) {
      this.logger.error('Error during disconnect', { error });
    }
  }

  /**
   * Subscribe to messages
   */
  async subscribe(
    handler: MessageHandler<T>,
    _options?: SubscribeOptions
  ): Promise<void> {
    if (!this.channel) {
      throw new ConnectionError('Consumer not connected');
    }

    const queueName = this.rabbitConfig.queue.name;
    const consumerOptions = this.rabbitConfig.consumer;

    const result = await this.channel.consume(
      queueName,
      async (msg: ConsumeMessage | null) => {
        if (!msg) {
          return;
        }

        if (this._paused) {
          // Reject and requeue when paused
          this.channel?.nack(msg, false, true);
          return;
        }

        const message = this.convertMessage(msg);
        try {
          await handler(message);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const result = await this.applyStrategy(message, err, () =>
            handler(message),
          );
          if (!result.handled) {
            this.logger.error('Error processing message', { error });
            // Legacy: message will be nacked by the handler or handled by the adapter
          }
        }
      },
      {
        consumerTag: consumerOptions?.consumerTag,
        noLocal: consumerOptions?.noLocal,
        noAck: consumerOptions?.noAck,
        exclusive: consumerOptions?.exclusive,
        priority: consumerOptions?.priority,
        arguments: consumerOptions?.arguments,
      }
    );

    this.consumerTag = result.consumerTag;

    this.logger.info('Subscribed to queue', {
      queue: queueName,
      consumerTag: this.consumerTag,
    });
  }

  /**
   * Subscribe to messages in batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.channel) {
      throw new ConnectionError('Consumer not connected');
    }

    const queueName = this.rabbitConfig.queue.name;
    const consumerOptions = this.rabbitConfig.consumer;
    const batchSize = options?.batchSize ?? 10;
    const batchTimeout = options?.batchTimeout ?? 5000;

    let batch: ConsumeMessage[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const processBatch = async () => {
      if (batch.length === 0) return;

      const currentBatch = [...batch];
      batch = [];

      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }

      const messages = currentBatch.map(msg => this.convertMessage(msg));
      try {
        await handler(messages);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // RabbitMQ supports per-message ack; apply strategy per message.
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
          this.logger.error('Error processing batch', { error });
          // Legacy: nack all in-flight messages with requeue.
          for (const msg of currentBatch) {
            this.channel?.nack(msg, false, true);
          }
        }
      }
    };

    const result = await this.channel.consume(
      queueName,
      async (msg: ConsumeMessage | null) => {
        if (!msg) {
          return;
        }

        if (this._paused) {
          this.channel?.nack(msg, false, true);
          return;
        }

        batch.push(msg);

        if (batch.length >= batchSize) {
          await processBatch();
        } else if (!batchTimer) {
          batchTimer = setTimeout(() => processBatch(), batchTimeout);
        }
      },
      {
        consumerTag: consumerOptions?.consumerTag,
        noLocal: consumerOptions?.noLocal,
        noAck: false, // Always manual ack for batch
        exclusive: consumerOptions?.exclusive,
        priority: consumerOptions?.priority,
        arguments: consumerOptions?.arguments,
      }
    );

    this.consumerTag = result.consumerTag;

    this.logger.info('Subscribed to queue (batch mode)', {
      queue: queueName,
      consumerTag: this.consumerTag,
      batchSize,
      batchTimeout,
    });
  }

  /**
   * Convert RabbitMQ message to IMessage format
   */
  private convertMessage(msg: ConsumeMessage) {
    const content = msg.content.toString('utf8');
    let body: T;

    try {
      body = JSON.parse(content) as T;
    } catch {
      body = content as unknown as T;
    }

    // Extract headers
    const headers: Record<string, string | Buffer | undefined> = {};
    if (msg.properties.headers) {
      for (const [key, value] of Object.entries(msg.properties.headers)) {
        if (Buffer.isBuffer(value)) {
          headers[key] = value;
        } else if (value !== undefined) {
          headers[key] = String(value);
        }
      }
    }

    const messageId = msg.properties.messageId ?? `rmq-${msg.fields.deliveryTag}`;
    const exchange = msg.fields.exchange;
    const routingKey = msg.fields.routingKey;
    const deliveryTag = msg.fields.deliveryTag;
    const redelivered = msg.fields.redelivered;

    return createMessage<T>({
      id: messageId,
      body,
      key: routingKey,
      headers,
      timestamp: msg.properties.timestamp
        ? new Date(msg.properties.timestamp)
        : new Date(),
      deliveryAttempt: redelivered ? 2 : 1,
      metadata: {
        provider: 'rabbitmq',
        rabbitmq: {
          exchange,
          routingKey,
          consumerTag: this.consumerTag ?? '',
          deliveryTag,
          redelivered,
        },
      },
      raw: msg,
      onAck: async () => {
        this.channel?.ack(msg);
        this.logger.debug('Message acknowledged', { messageId, deliveryTag });
      },
      onNack: async (requeue = true) => {
        this.channel?.nack(msg, false, requeue);
        this.logger.debug('Message negatively acknowledged', {
          messageId,
          deliveryTag,
          requeue,
        });
      },
      onExtendDeadline: async (_seconds: number) => {
        // RabbitMQ doesn't support deadline extension
        this.logger.debug('Deadline extension not supported in RabbitMQ', { messageId });
      },
    });
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.channel) {
        return {
          healthy: false,
          connected: false,
          error: 'Not connected',
        };
      }

      // Check queue exists
      await this.channel.checkQueue(this.rabbitConfig.queue.name);

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          queue: this.rabbitConfig.queue.name,
          exchange: this.rabbitConfig.exchange?.name,
          paused: this._paused,
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
}

/**
 * Create a RabbitMQ consumer instance
 */
export function createRabbitMQConsumer<T = unknown>(
  config: RabbitMQConsumerConfig
): RabbitMQConsumer<T> {
  return new RabbitMQConsumer<T>(config);
}
