/**
 * NATS JetStream Producer Implementation
 */

import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  StringCodec,
  headers as createHeaders,
  type PubAck,
  StorageType,
  RetentionPolicy,
  DiscardPolicy,
} from 'nats';
import {
  BaseProducer,
  type PublishOptions,
  type HealthStatus,
  ConnectionError,
  PublishError,
  generateUUID,
} from '@anyq/core';
import type { NATSProducerConfig } from './config.js';
import { NATS_DEFAULTS } from './config.js';

/**
 * NATS JetStream Producer
 *
 * Publishes messages to NATS JetStream for persistent messaging
 */
export class NATSProducer<T = unknown> extends BaseProducer<T> {
  private connection: NatsConnection | null = null;
  private jetstream: JetStreamClient | null = null;
  private jetstreamManager: JetStreamManager | null = null;
  private readonly natsConfig: NATSProducerConfig;
  private readonly sc = StringCodec();

  constructor(config: NATSProducerConfig) {
    super(config);
    this.natsConfig = {
      ...config,
      connection: {
        ...NATS_DEFAULTS.connection,
        ...config.connection,
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

      // Get JetStream client and manager
      this.jetstream = this.connection.jetstream();
      this.jetstreamManager = await this.connection.jetstreamManager();

      // Ensure stream exists
      await this.ensureStream();

      this._connected = true;
      this.logger.info('NATS producer connected', {
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
      // Try to get existing stream info
      await this.jetstreamManager.streams.info(streamName);
      this.logger.debug('Stream already exists', { stream: streamName });
    } catch {
      // Stream doesn't exist, create it
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
        duplicate_window: jsConfig.duplicateWindow ?? 120 * 1e9, // 2 minutes in nanoseconds
      });
    }
  }

  /**
   * Convert retention policy string to NATS constant
   */
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
    if (this.connection) {
      await this.connection.drain();
      this.connection = null;
      this.jetstream = null;
      this.jetstreamManager = null;
      this._connected = false;
      this.logger.info('NATS producer disconnected');
    }
  }

  /**
   * Publish a single message to JetStream
   */
  async publish(body: T, options?: PublishOptions): Promise<string> {
    if (!this.jetstream) {
      throw new ConnectionError('NATS producer not connected');
    }

    const messageId = generateUUID();
    const subject = options?.key ?? this.natsConfig.subject;

    // Create headers
    const hdrs = createHeaders();
    hdrs.set('Nats-Msg-Id', messageId);

    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (value !== undefined) {
          hdrs.set(key, String(value));
        }
      }
    }

    // Serialize the message
    const payload = this.sc.encode(JSON.stringify({
      id: messageId,
      body,
      headers: options?.headers,
      timestamp: new Date().toISOString(),
    }));

    try {
      const ack: PubAck = await this.jetstream.publish(subject, payload, {
        headers: hdrs,
        msgID: messageId,
        expect: this.natsConfig.expectedStream ? {
          streamName: this.natsConfig.expectedStream,
        } : undefined,
      });

      this.logger.debug('Message published', {
        messageId,
        subject,
        stream: ack.stream,
        seq: ack.seq,
      });

      return messageId;
    } catch (error) {
      throw new PublishError('Failed to publish message', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Publish multiple messages in batch
   */
  async publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]> {
    const results: string[] = [];

    for (const msg of messages) {
      const result = await this.publish(msg.body, msg.options);
      results.push(result);
    }

    return results;
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
 * Create a NATS producer instance
 */
export function createNATSProducer<T = unknown>(
  config: NATSProducerConfig
): NATSProducer<T> {
  return new NATSProducer<T>(config);
}
