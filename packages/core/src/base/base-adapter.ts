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
import type {
  RetryDecision,
  RetryStrategy,
  RetryStrategyContext,
} from '../strategies/types.js';
import { BACKPRESSURE_PAUSE_STRATEGY_NAME } from '../strategies/types.js';

/**
 * Sleep for the given milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Result returned by {@link BaseConsumer.applyStrategy}.
 *
 * - `handled: false` means no `strategy` was configured; the adapter should
 *   fall through to its legacy catch-block behaviour.
 * - `handled: true` means the strategy ran to completion (possibly after an
 *   in-process retry loop).
 */
export interface ApplyStrategyResult {
  handled: boolean;
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
  private _backpressureResumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BaseQueueConfig, serializer?: ISerializer<T>) {
    super(config);
    this.serializer = serializer ?? (new JsonSerializer() as ISerializer<T>);
  }

  /**
   * Whether this adapter can natively schedule delayed redelivery (the `park`
   * decision). Override in adapter subclasses; defaults to `false`.
   *
   * When `false`, a `park` decision in {@link applyStrategy} downgrades to an
   * in-process `retry` with the same delay and logs a warning.
   */
  protected get supportsNativeDelay(): boolean {
    return false;
  }

  /**
   * Adapter-provided dead-letter hook. Subclasses MAY override to route
   * messages to a broker-native DLQ (SQS redrive, RabbitMQ DLX, etc.).
   *
   * Default implementation logs a warning and calls `nack(false)` to drop
   * the message without requeue.
   */
  protected async deadLetterMessage(
    message: IMessage<T>,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      'No native dead-letter hook; dropping message via nack(false)',
      { messageId: message.id, reason },
    );
    await message.nack(false);
  }

  /**
   * Adapter-provided scheduled-retry hook. Subclasses MUST override when
   * {@link supportsNativeDelay} returns `true`.
   *
   * Adapters that do not support native delay can leave this as the default;
   * {@link applyStrategy} will downgrade `park` to in-process retry instead.
   */
  protected async parkMessage(
    _message: IMessage<T>,
    _delayMs: number,
  ): Promise<void> {
    // Intentionally unreachable: applyStrategy only calls this when
    // supportsNativeDelay is true. Override in adapter subclasses.
    throw new Error(
      'parkMessage() not implemented; override in adapter or set supportsNativeDelay=false',
    );
  }

  /**
   * Resolve the effective maxAttempts for the strategy context.
   *
   * Precedence: deadLetterQueue.maxDeliveryAttempts -> retry.maxRetries + 1 ->
   * DEFAULT_RETRY_CONFIG.maxRetries + 1.
   *
   * Strategy-level overrides (e.g. `retryThenDeadLetter({ maxAttempts })`)
   * take precedence inside the strategy itself.
   */
  protected resolveMaxAttempts(): number {
    const dlqMax = this.config.deadLetterQueue?.maxDeliveryAttempts;
    if (typeof dlqMax === 'number' && dlqMax > 0) {
      return dlqMax;
    }
    const retryMax = this.config.retry?.maxRetries;
    if (typeof retryMax === 'number' && retryMax >= 0) {
      return retryMax + 1;
    }
    return DEFAULT_RETRY_CONFIG.maxRetries + 1;
  }

  /**
   * Apply the configured retry strategy to a failed message.
   *
   * Boundary: the parent {@link BaseAdapter} circuit breaker handles
   * connection/transport failure; retry strategies handle per-message handler
   * failure. The two pause mechanisms (open circuit vs. backpressure pause)
   * are independent, and strategies MUST NOT trip the breaker.
   *
   * @param message  - The message whose handler threw.
   * @param error    - The thrown error (already coerced to Error).
   * @param reinvoke - Optional re-invocation callback used by the in-process
   *                   retry loop. If omitted, the `retry` decision falls
   *                   through to `deadLetter` once attempts are exhausted on
   *                   the broker side.
   * @returns `{ handled: false }` when no strategy is configured (the
   *          adapter's catch block should fall back to legacy behaviour);
   *          `{ handled: true }` otherwise.
   */
  protected async applyStrategy(
    message: IMessage<T>,
    error: Error,
    reinvoke?: () => Promise<void>,
  ): Promise<ApplyStrategyResult> {
    const strategy = this.config.strategy as RetryStrategy<T> | undefined;
    if (!strategy) {
      return { handled: false };
    }

    const maxAttempts = this.resolveMaxAttempts();
    let currentError = error;
    let currentAttempt = message.deliveryAttempt;

    // The in-process retry loop: a strategy may return `retry` repeatedly
    // until attempts exhaust, the error becomes non-retryable, or the
    // strategy returns a non-retry decision.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ctx: RetryStrategyContext<T> = {
        message,
        error: currentError,
        attempt: currentAttempt,
        maxAttempts,
      };

      let decision: RetryDecision;
      try {
        decision = await strategy.decide(ctx);
      } catch (decideErr) {
        this.logger.error('Retry strategy threw; treating as deadLetter', {
          strategy: strategy.name,
          messageId: message.id,
          error:
            decideErr instanceof Error ? decideErr.message : String(decideErr),
        });
        decision = {
          action: 'deadLetter',
          reason:
            decideErr instanceof Error ? decideErr.message : String(decideErr),
        };
      }

      // Emit error event for observability on every non-ack outcome.
      if (decision.action !== 'ack') {
        this.emit('error', currentError);
      }

      switch (decision.action) {
        case 'ack': {
          await message.ack();
          return { handled: true };
        }
        case 'requeue': {
          await message.nack(true);
          return { handled: true };
        }
        case 'fail': {
          // Rethrow; matches logAndFail semantics.
          throw currentError;
        }
        case 'deadLetter': {
          await this.deadLetterMessage(message, decision.reason);
          return { handled: true };
        }
        case 'park': {
          // Backpressure pause runs regardless of native vs downgrade — the
          // intent is "stop hammering the downstream system" and that holds
          // whether we re-queue via the broker or retry in-process.
          if (strategy.name === BACKPRESSURE_PAUSE_STRATEGY_NAME) {
            await this.pause();
            if (this._backpressureResumeTimer) {
              clearTimeout(this._backpressureResumeTimer);
            }
            this._backpressureResumeTimer = setTimeout(() => {
              this._backpressureResumeTimer = null;
              this.resume().catch((resumeErr: unknown) => {
                this.logger.error('Failed to resume after backpressure pause', {
                  error:
                    resumeErr instanceof Error
                      ? resumeErr.message
                      : String(resumeErr),
                });
              });
            }, decision.delayMs);
          }

          if (this.supportsNativeDelay) {
            await this.parkMessage(message, decision.delayMs);
            return { handled: true };
          }

          // Downgrade: in-process retry after the requested delay, capped by
          // maxAttempts so a perpetually-failing handler can't spin forever.
          this.logger.warn(
            'park requested but adapter has no native delay; downgrading to in-process retry',
            {
              strategy: strategy.name,
              messageId: message.id,
              delayMs: decision.delayMs,
            },
          );
          if (!reinvoke) {
            await this.deadLetterMessage(
              message,
              'park downgrade requested but no reinvoke callback available',
            );
            return { handled: true };
          }
          if (currentAttempt >= maxAttempts) {
            await this.deadLetterMessage(
              message,
              'max attempts exceeded (park downgrade)',
            );
            return { handled: true };
          }
          await sleep(decision.delayMs);
          try {
            await reinvoke();
            await message.ack();
            return { handled: true };
          } catch (reErr) {
            currentError =
              reErr instanceof Error ? reErr : new Error(String(reErr));
            currentAttempt += 1;
            continue;
          }
        }
        case 'retry': {
          if (!reinvoke) {
            // Without a reinvoke callback, fall through to deadLetter on
            // exhaustion or just dead-letter immediately.
            this.logger.warn(
              'retry requested but no reinvoke callback supplied; dead-lettering',
              {
                strategy: strategy.name,
                messageId: message.id,
              },
            );
            await this.deadLetterMessage(message, 'retry without reinvoke');
            return { handled: true };
          }
          if (currentAttempt >= maxAttempts) {
            await this.deadLetterMessage(message, 'max attempts exceeded');
            return { handled: true };
          }
          await sleep(decision.delayMs);
          try {
            await reinvoke();
            await message.ack();
            return { handled: true };
          } catch (reErr) {
            currentError =
              reErr instanceof Error ? reErr : new Error(String(reErr));
            currentAttempt += 1;
            continue;
          }
        }
        default: {
          // Forward-compatible: future minor versions MAY add RetryDecision
          // variants. Treat unknown actions as deadLetter so library updates
          // don't break adapters at runtime.
          this.logger.warn('Unknown retry decision; dead-lettering', {
            strategy: strategy.name,
            messageId: message.id,
            action: (decision as { action?: string }).action,
          });
          await this.deadLetterMessage(message, 'unknown decision');
          return { handled: true };
        }
      }
    }
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
