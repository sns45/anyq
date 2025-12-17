/**
 * @fileoverview Base adapter classes for anyq
 * @module @anyq/core/base/base-adapter
 */

import type {
  BaseQueueConfig,
  Logger,
  RetryConfig,
  CircuitBreakerConfig,
} from '../types/config.js';
import type { IMessage, MessageCreateParams } from '../types/message.js';
import type {
  IProducer,
  PublishOptions,
  HealthStatus,
} from '../types/producer.js';
import type {
  IConsumer,
  MessageHandler,
  BatchMessageHandler,
  SubscribeOptions,
  ConsumerEvents,
} from '../types/consumer.js';
import {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../types/config.js';
import { createLogger } from '../utils/logger.js';
import { CircuitBreaker } from '../middleware/circuit-breaker.js';
import { withRetry } from '../middleware/retry.js';
import type { ISerializer } from '../serialization/types.js';
import { JsonSerializer } from '../serialization/json.js';

/**
 * Create a message instance from parameters
 */
export function createMessage<T>(params: MessageCreateParams<T>): IMessage<T> {
  return {
    id: params.id,
    body: params.body,
    key: params.key,
    headers: params.headers,
    timestamp: params.timestamp,
    deliveryAttempt: params.deliveryAttempt,
    metadata: params.metadata,
    raw: params.raw,
    ack: params.onAck,
    nack: params.onNack,
    extendDeadline: params.onExtendDeadline,
  };
}

/**
 * Base class for queue adapters
 *
 * Provides common functionality like logging, circuit breaking,
 * retry logic, and serialization.
 */
export abstract class BaseAdapter {
  protected readonly config: BaseQueueConfig;
  protected readonly logger: Logger;
  protected readonly circuitBreaker: CircuitBreaker;
  protected readonly retryConfig: RetryConfig;
  protected _connected = false;

  constructor(config: BaseQueueConfig) {
    this.config = config;
    this.logger = createLogger(config.logging, config.clientId ?? config.driver);
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
    };

    const cbConfig: CircuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config.circuitBreaker,
    };
    this.circuitBreaker = new CircuitBreaker(cbConfig);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Execute operation with retry and circuit breaker
   */
  protected async executeWithResilience<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      return withRetry(operation, {
        ...this.retryConfig,
        onRetry: (attempt) => {
          this.logger.warn(`Retrying ${operationName}`, {
            attempt: attempt.attempt,
            maxAttempts: attempt.maxAttempts,
            delayMs: attempt.delayMs,
            error: attempt.error?.message,
          });
        },
      });
    });
  }
}

/**
 * Base producer class
 */
export abstract class BaseProducer<T = unknown>
  extends BaseAdapter
  implements IProducer<T>
{
  protected serializer: ISerializer<T>;

  constructor(config: BaseQueueConfig, serializer?: ISerializer<T>) {
    super(config);
    this.serializer = serializer ?? (new JsonSerializer() as ISerializer<T>);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract publish(body: T, options?: PublishOptions): Promise<string>;
  abstract publishBatch(
    messages: Array<{ body: T; options?: PublishOptions }>
  ): Promise<string[]>;

  async flush(): Promise<void> {
    // Default no-op, override in adapters that support batching
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      // Subclasses should override with actual health check
      return {
        healthy: this._connected,
        connected: this._connected,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Simple event emitter for consumers
 */
export class EventEmitter<T = unknown> {
  private listeners: Map<keyof ConsumerEvents<T>, Set<Function>> = new Map();

  on<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit<K extends keyof ConsumerEvents<T>>(
    event: K,
    ...args: Parameters<ConsumerEvents<T>[K]>
  ): boolean {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) {
      return false;
    }
    for (const listener of eventListeners) {
      try {
        (listener as Function)(...args);
      } catch (error) {
        console.error(`Error in event listener for ${String(event)}:`, error);
      }
    }
    return true;
  }
}

/**
 * Base consumer class
 */
export abstract class BaseConsumer<T = unknown>
  extends BaseAdapter
  implements IConsumer<T>
{
  protected serializer: ISerializer<T>;
  protected _paused = false;
  protected eventEmitter = new EventEmitter<T>();

  constructor(config: BaseQueueConfig, serializer?: ISerializer<T>) {
    super(config);
    this.serializer = serializer ?? (new JsonSerializer() as ISerializer<T>);
  }

  // Event emitter methods
  on<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  off<K extends keyof ConsumerEvents<T>>(
    event: K,
    listener: ConsumerEvents<T>[K]
  ): this {
    this.eventEmitter.off(event, listener);
    return this;
  }

  emit<K extends keyof ConsumerEvents<T>>(
    event: K,
    ...args: Parameters<ConsumerEvents<T>[K]>
  ): boolean {
    return this.eventEmitter.emit(event, ...args);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void>;
  abstract subscribeBatch(
    handler: BatchMessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<void>;

  async pause(): Promise<void> {
    this._paused = true;
    this.logger.info('Consumer paused');
  }

  async resume(): Promise<void> {
    this._paused = false;
    this.logger.info('Consumer resumed');
  }

  isPaused(): boolean {
    return this._paused;
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      return {
        healthy: this._connected,
        connected: this._connected,
        latencyMs: Date.now() - start,
        details: {
          paused: this._paused,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
