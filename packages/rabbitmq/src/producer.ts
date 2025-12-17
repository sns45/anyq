/**
 * RabbitMQ Producer Implementation
 */

import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
  generateUUID,
} from '@anyq/core';
import type { RabbitMQProducerConfig } from './config.js';
import { RABBITMQ_DEFAULTS } from './config.js';

/**
 * RabbitMQ Producer
 *
 * Publishes messages to RabbitMQ exchanges
 */
export class RabbitMQProducer<T = unknown> extends BaseProducer<T> {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private readonly rabbitConfig: RabbitMQProducerConfig;

  constructor(config: RabbitMQProducerConfig) {
    super(config);
    this.rabbitConfig = {
      ...config,
      connection: {
        ...RABBITMQ_DEFAULTS.connection,
        ...config.connection,
      },
      exchange: {
        ...RABBITMQ_DEFAULTS.exchange,
        ...config.exchange,
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
      const { connection: connConfig, exchange: exchangeConfig } = this.rabbitConfig;

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

      // Create confirm channel for reliable publishing
      this.channel = await this.connection.createConfirmChannel();

      // Assert exchange
      await this.channel.assertExchange(exchangeConfig.name, exchangeConfig.type, {
        durable: exchangeConfig.durable,
        autoDelete: exchangeConfig.autoDelete,
        internal: exchangeConfig.internal,
        arguments: exchangeConfig.arguments,
      });

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
      this.logger.info('RabbitMQ producer connected', {
        url: connConfig.url,
        exchange: exchangeConfig.name,
        type: exchangeConfig.type,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to RabbitMQ',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from RabbitMQ
   */
  async disconnect(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      this._connected = false;
      this.logger.info('RabbitMQ producer disconnected');
    } catch (error) {
      this.logger.error('Error during disconnect', { error });
    }
  }

  /**
   * Publish a single message
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.channel) {
      throw new ConnectionError('Producer not connected');
    }

    const messageId = generateUUID();
    const routingKey = options?.key ?? this.rabbitConfig.routingKey ?? '';
    const exchange = this.rabbitConfig.exchange.name;

    try {
      const serializedBody = this.serializer.serialize(body);
      const content = Buffer.isBuffer(serializedBody)
        ? serializedBody
        : Buffer.from(serializedBody);

      // Build message properties
      const messageOptions: amqp.Options.Publish = {
        messageId,
        timestamp: Date.now(),
        contentType: 'application/json',
        deliveryMode: this.rabbitConfig.persistent !== false ? 2 : 1, // 2 = persistent
        mandatory: this.rabbitConfig.mandatory,
        priority: options?.priority,
        correlationId: options?.correlationId,
        replyTo: options?.replyTo,
        expiration: options?.ttlMs?.toString(),
        headers: options?.headers as Record<string, unknown>,
      };

      // Publish with confirmation
      return new Promise<string>((resolve, reject) => {
        const published = this.channel!.publish(
          exchange,
          routingKey,
          content,
          messageOptions,
          (err) => {
            if (err) {
              reject(new PublishError('Publish failed', { cause: err }));
            } else {
              this.logger.debug('Message published', {
                messageId,
                exchange,
                routingKey,
              });
              resolve(messageId);
            }
          }
        );

        if (!published) {
          // Channel buffer is full
          this.channel!.once('drain', () => {
            this.logger.warn('Channel drained after backpressure');
          });
        }
      });
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    const results: string[] = [];

    for (const { body, options } of messages) {
      const messageId = await this.publish(body, options);
      results.push(messageId);
    }

    // Wait for all confirms
    await this.channel?.waitForConfirms();

    this.logger.debug('Batch published', {
      count: results.length,
      exchange: this.rabbitConfig.exchange.name,
    });

    return results;
  }

  /**
   * Flush pending messages
   */
  async flush(): Promise<void> {
    if (this.channel) {
      await this.channel.waitForConfirms();
    }
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

      // Check exchange exists
      await this.channel.checkExchange(this.rabbitConfig.exchange.name);

      return {
        healthy: true,
        connected: true,
        latencyMs: Date.now() - start,
        details: {
          exchange: this.rabbitConfig.exchange.name,
          type: this.rabbitConfig.exchange.type,
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
 * Create a RabbitMQ producer instance
 */
export function createRabbitMQProducer<T = unknown>(
  config: RabbitMQProducerConfig
): RabbitMQProducer<T> {
  return new RabbitMQProducer<T>(config);
}
