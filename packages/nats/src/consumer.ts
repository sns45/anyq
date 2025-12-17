/**
 * NATS JetStream Consumer Implementation
 */

import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
  type JsMsg,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  StorageType,
  RetentionPolicy,
  DiscardPolicy,
} from 'nats';
import {
  BaseConsumer,
  createMessage,
  type MessageHandler,
  type BatchMessageHandler,
  type SubscribeOptions,
  type HealthStatus,
  ConnectionError,
  generateUUID,
} from '@anyq/core';
import type { NATSConsumerConfig as NATSConsumerConfigType } from './config.js';
import { NATS_DEFAULTS } from './config.js';

/**
 * Parsed message from NATS
 */
interface ParsedMessage<T> {
  id: string;
  body: T;
  headers?: Record<string, string | number | boolean>;
  timestamp: string;
}

/**
 * NATS JetStream Consumer
 *
 * Consumes messages from NATS JetStream with acknowledgment support
 */
export class NATSConsumer<T = unknown> extends BaseConsumer<T> {
  private connection: NatsConnection | null = null;
  private jetstream: JetStreamClient | null = null;
  private jetstreamManager: JetStreamManager | null = null;
  private consumerMessages: ConsumerMessages | null = null;
  private readonly natsConfig: NATSConsumerConfigType;
  private readonly sc = StringCodec();
  private processingLoop: Promise<void> | null = null;
  private shouldStop = false;

  constructor(config: NATSConsumerConfigType) {
    super(config);
    this.natsConfig = {
      ...config,
      connection: {
        ...NATS_DEFAULTS.connection,
        ...config.connection,
      },
      consumer: {
        ...NATS_DEFAULTS.consumer,
        ...config.consumer,
      },
    };
  }

  /**
   * Connect to NATS server and initialize JetStream
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    try {
      const { connection: connConfig } = this.natsConfig;

      this.connection = await connect({
        servers: connConfig.servers,
        name: connConfig.name,
        user: connConfig.user,
        pass: connConfig.pass,
        token: connConfig.token,
        maxReconnectAttempts: connConfig.maxReconnectAttempts,
        reconnectTimeWait: connConfig.reconnectTimeWait,
        timeout: connConfig.timeout,
        pingInterval: connConfig.pingInterval,
        tls: connConfig.tls ? {
          certFile: connConfig.tls.certFile,
          keyFile: connConfig.tls.keyFile,
          caFile: connConfig.tls.caFile,
        } : undefined,
      });

      this.jetstream = this.connection.jetstream();
      this.jetstreamManager = await this.connection.jetstreamManager();

      // Ensure stream exists
      await this.ensureStream();

      this._connected = true;
      this.logger.info('NATS consumer connected', {
        servers: connConfig.servers,
        stream: this.natsConfig.jetstream.stream,
        subject: this.natsConfig.subject,
      });
    } catch (error) {
      throw new ConnectionError(
        'Failed to connect to NATS',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Ensure the JetStream stream exists
   */
  private async ensureStream(): Promise<void> {
    if (!this.jetstreamManager) {
      throw new Error('JetStream manager not initialized');
    }

    const { jetstream: jsConfig } = this.natsConfig;
    const streamName = jsConfig.stream;
    const subjects = jsConfig.subjects ?? [this.natsConfig.subject];

    try {
      await this.jetstreamManager.streams.info(streamName);
      this.logger.debug('Stream already exists', { stream: streamName });
    } catch {
      this.logger.info('Creating stream', { stream: streamName, subjects });

      await this.jetstreamManager.streams.add({
        name: streamName,
        subjects,
        storage: jsConfig.storage === 'file' ? StorageType.File : StorageType.Memory,
        num_replicas: jsConfig.replicas ?? 1,
        retention: this.getRetentionPolicy(jsConfig.retention),
        max_msgs: jsConfig.maxMsgs ?? -1,
        max_bytes: jsConfig.maxBytes ?? -1,
        max_age: jsConfig.maxAge ?? 0,
        discard: jsConfig.discard === 'new' ? DiscardPolicy.New : DiscardPolicy.Old,
        duplicate_window: jsConfig.duplicateWindow ?? 120 * 1e9,
      });
    }
  }

  private getRetentionPolicy(retention?: string): RetentionPolicy {
    switch (retention) {
      case 'interest':
        return RetentionPolicy.Interest;
      case 'workqueue':
        return RetentionPolicy.Workqueue;
      default:
        return RetentionPolicy.Limits;
    }
  }

  /**
   * Disconnect from NATS server
   */
  async disconnect(): Promise<void> {
    this.shouldStop = true;

    if (this.consumerMessages) {
      this.consumerMessages.stop();
      this.consumerMessages = null;
    }

    if (this.processingLoop) {
      await this.processingLoop;
      this.processingLoop = null;
    }

    if (this.connection) {
      await this.connection.drain();
      this.connection = null;
      this.jetstream = null;
      this.jetstreamManager = null;
      this._connected = false;
      this.logger.info('NATS consumer disconnected');
    }
  }

  /**
   * Subscribe to messages from JetStream
   */
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.jetstream || !this.jetstreamManager) {
      throw new ConnectionError('NATS consumer not connected');
    }

    const consumerConfig = this.natsConfig.consumer;
    const streamName = this.natsConfig.jetstream.stream;
    const durableName = consumerConfig?.durableName ?? `consumer-${generateUUID()}`;

    try {
      // Create or get consumer
      const consumerInfo = await this.ensureConsumer(streamName, durableName);
      this.logger.info('Consumer ready', {
        stream: streamName,
        consumer: consumerInfo.name,
        subject: this.natsConfig.subject,
      });

      // Get consumer for message consumption
      const consumer = await this.jetstream.consumers.get(streamName, durableName);

      // Start consuming messages
      this.consumerMessages = await consumer.consume({
        max_messages: consumerConfig?.batch ?? 10,
        expires: consumerConfig?.expires ?? 5000,
      });

      this.shouldStop = false;
      this.processingLoop = this.processMessages(handler, options);

    } catch (error) {
      this.logger.error('Failed to subscribe', { error });
      throw error;
    }
  }

  /**
   * Subscribe to messages in batches
   */
  async subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void> {
    if (!this.jetstream || !this.jetstreamManager) {
      throw new ConnectionError('NATS consumer not connected');
    }

    const consumerConfig = this.natsConfig.consumer;
    const streamName = this.natsConfig.jetstream.stream;
    const durableName = consumerConfig?.durableName ?? `consumer-${generateUUID()}`;

    try {
      const consumerInfo = await this.ensureConsumer(streamName, durableName);
      this.logger.info('Consumer ready (batch mode)', {
        stream: streamName,
        consumer: consumerInfo.name,
        subject: this.natsConfig.subject,
      });

      const consumer = await this.jetstream.consumers.get(streamName, durableName);
      this.consumerMessages = await consumer.consume({
        max_messages: consumerConfig?.batch ?? 10,
        expires: consumerConfig?.expires ?? 5000,
      });

      this.shouldStop = false;
      this.processingLoop = this.processBatchMessages(handler, options);

    } catch (error) {
      this.logger.error('Failed to subscribe batch', { error });
      throw error;
    }
  }

  /**
   * Ensure consumer exists on the stream
   */
  private async ensureConsumer(streamName: string, durableName: string) {
    if (!this.jetstreamManager) {
      throw new Error('JetStream manager not initialized');
    }

    const consumerConfig = this.natsConfig.consumer;

    try {
      // Try to get existing consumer
      return await this.jetstreamManager.consumers.info(streamName, durableName);
    } catch {
      // Consumer doesn't exist, create it
      this.logger.info('Creating consumer', { stream: streamName, consumer: durableName });

      return await this.jetstreamManager.consumers.add(streamName, {
        durable_name: durableName,
        description: consumerConfig?.description,
        deliver_policy: this.getDeliverPolicy(consumerConfig?.deliverPolicy),
        ack_policy: AckPolicy.Explicit,
        ack_wait: consumerConfig?.ackWait ?? 30 * 1e9,
        max_deliver: consumerConfig?.maxDeliver ?? 5,
        filter_subject: consumerConfig?.filterSubject ?? this.natsConfig.subject,
        max_ack_pending: consumerConfig?.maxAckPending ?? 1000,
        replay_policy: consumerConfig?.replayPolicy === 'original'
          ? ReplayPolicy.Original
          : ReplayPolicy.Instant,
      });
    }
  }

  private getDeliverPolicy(policy?: string): DeliverPolicy {
    switch (policy) {
      case 'last':
        return DeliverPolicy.Last;
      case 'new':
        return DeliverPolicy.New;
      case 'byStartSequence':
        return DeliverPolicy.StartSequence;
      case 'byStartTime':
        return DeliverPolicy.StartTime;
      case 'lastPerSubject':
        return DeliverPolicy.LastPerSubject;
      default:
        return DeliverPolicy.All;
    }
  }

  /**
   * Process incoming messages
   */
  private async processMessages(
    handler: MessageHandler<T>,
    _options?: SubscribeOptions
  ): Promise<void> {
    if (!this.consumerMessages) {
      return;
    }

    try {
      for await (const jsMsg of this.consumerMessages) {
        if (this.shouldStop) {
          break;
        }

        if (this._paused) {
          // Re-deliver the message later when paused
          jsMsg.nak();
          continue;
        }

        try {
          const message = this.convertMessage(jsMsg);
          await handler(message);
        } catch (error) {
          this.logger.error('Error processing message', { error });
          // Message will be redelivered based on maxDeliver config
        }
      }
    } catch (error) {
      if (!this.shouldStop) {
        this.logger.error('Consumer loop error', { error });
      }
    }
  }

  /**
   * Process incoming messages in batches
   */
  private async processBatchMessages(
    handler: BatchMessageHandler<T>,
    _options?: SubscribeOptions
  ): Promise<void> {
    if (!this.consumerMessages) {
      return;
    }

    const batchSize = this.natsConfig.consumer?.batch ?? 10;
    const batchTimeout = this.natsConfig.consumer?.expires ?? 5000;

    try {
      let batch: JsMsg[] = [];
      let batchStart = Date.now();

      for await (const jsMsg of this.consumerMessages) {
        if (this.shouldStop) {
          break;
        }

        if (this._paused) {
          jsMsg.nak();
          continue;
        }

        batch.push(jsMsg);

        // Process batch if full or timeout reached
        if (batch.length >= batchSize || Date.now() - batchStart > batchTimeout) {
          if (batch.length > 0) {
            try {
              const messages = batch.map(msg => this.convertMessage(msg));
              await handler(messages);
            } catch (error) {
              this.logger.error('Error processing batch', { error });
            }
            batch = [];
            batchStart = Date.now();
          }
        }
      }

      // Process remaining messages
      if (batch.length > 0) {
        try {
          const messages = batch.map(msg => this.convertMessage(msg));
          await handler(messages);
        } catch (error) {
          this.logger.error('Error processing final batch', { error });
        }
      }
    } catch (error) {
      if (!this.shouldStop) {
        this.logger.error('Consumer batch loop error', { error });
      }
    }
  }

  /**
   * Convert NATS JetStream message to IMessage format
   */
  private convertMessage(jsMsg: JsMsg) {
    const data = this.sc.decode(jsMsg.data);
    let parsed: ParsedMessage<T>;

    try {
      parsed = JSON.parse(data) as ParsedMessage<T>;
    } catch {
      // If not JSON, treat data as the body
      parsed = {
        id: jsMsg.info.streamSequence.toString(),
        body: data as unknown as T,
        timestamp: new Date().toISOString(),
      };
    }

    const messageId = parsed.id ?? jsMsg.info.streamSequence.toString();
    const redelivered = jsMsg.info.redelivered;
    const redeliveryCount = jsMsg.info.redeliveryCount;

    // Convert headers to MessageHeaders format (string | Buffer | undefined)
    const headers: Record<string, string | Buffer | undefined> = {};
    if (parsed.headers) {
      for (const [key, value] of Object.entries(parsed.headers)) {
        headers[key] = value !== undefined ? String(value) : undefined;
      }
    }

    return createMessage<T>({
      id: messageId,
      body: parsed.body,
      headers,
      timestamp: new Date(parsed.timestamp ?? Date.now()),
      deliveryAttempt: redeliveryCount + 1,
      metadata: {
        provider: 'nats',
        nats: {
          stream: jsMsg.info.stream,
          subject: jsMsg.subject,
          sequence: jsMsg.info.streamSequence,
          redelivered,
          redeliveryCount,
        },
      },
      raw: jsMsg,
      onAck: async () => {
        jsMsg.ack();
        this.logger.debug('Message acknowledged', { messageId });
      },
      onNack: async () => {
        jsMsg.nak();
        this.logger.debug('Message negatively acknowledged', { messageId });
      },
      onExtendDeadline: async (_seconds: number) => {
        // NATS uses working indicator to extend processing time
        jsMsg.working();
        this.logger.debug('Message deadline extended', { messageId });
      },
    });
  }

  /**
   * Get health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      if (!this._connected || !this.connection || this.connection.isClosed()) {
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
          stream: this.natsConfig.jetstream.stream,
          subject: this.natsConfig.subject,
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
 * Create a NATS consumer instance
 */
export function createNATSConsumer<T = unknown>(
  config: NATSConsumerConfigType
): NATSConsumer<T> {
  return new NATSConsumer<T>(config);
}
