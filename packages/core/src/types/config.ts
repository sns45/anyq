/**
 * @fileoverview Configuration types for anyq
 * @module @anyq/core/types/config
 */

/**
 * Supported queue drivers
 */
export type QueueDriver =
  | 'memory'
  | 'redis-streams'
  | 'rabbitmq'
  | 'sqs'
  | 'sns'
  | 'google-pubsub'
  | 'kafka'
  | 'nats'
  | 'azure-servicebus';

/**
 * Retry configuration with exponential backoff
 */
export interface RetryConfig {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries: number;
  /** Initial delay in milliseconds. Default: 100 */
  initialDelayMs: number;
  /** Maximum delay in milliseconds. Default: 10000 */
  maxDelayMs: number;
  /** Backoff multiplier. Default: 2 */
  multiplier: number;
  /** Add random jitter to prevent thundering herd. Default: true */
  jitter: boolean;
  /** Error patterns that should trigger retry */
  retryableErrors?: string[];
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Enable circuit breaker. Default: false */
  enabled: boolean;
  /** Failures before opening circuit. Default: 5 */
  failureThreshold: number;
  /** Time window for counting failures in ms. Default: 60000 */
  failureWindow: number;
  /** Time before attempting reset in ms. Default: 30000 */
  resetTimeout: number;
  /** Successful calls needed to close circuit. Default: 2 */
  successThreshold: number;
}

/**
 * Dead Letter Queue configuration
 */
export interface DeadLetterConfig {
  /** Enable DLQ handling */
  enabled: boolean;
  /** DLQ destination (topic/queue name or URL) */
  destination: string;
  /** Max delivery attempts before sending to DLQ. Default: 3 */
  maxDeliveryAttempts: number;
  /** Include error details in DLQ message. Default: true */
  includeError: boolean;
}

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger interface for custom implementations
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Logging configuration
 */
export interface LogConfig {
  /** Enable logging. Default: true */
  enabled: boolean;
  /** Log level. Default: 'info' */
  level: LogLevel;
  /** Custom logger instance */
  logger?: Logger;
}

/**
 * Base configuration shared by all queue drivers
 */
export interface BaseQueueConfig {
  /** Queue driver type (optional - adapters can default it) */
  driver?: QueueDriver;

  /** Client identifier for logging/tracing */
  clientId?: string;

  /** Retry configuration */
  retry?: Partial<RetryConfig>;

  /** Circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;

  /** Dead Letter Queue configuration */
  deadLetterQueue?: DeadLetterConfig;

  /** Logging configuration */
  logging?: Partial<LogConfig>;

  /** Connection timeout in milliseconds. Default: 10000 */
  connectionTimeout?: number;

  /** Request timeout in milliseconds. Default: 30000 */
  requestTimeout?: number;
}

/**
 * Default retry configuration values
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 10000,
  multiplier: 2,
  jitter: true,
};

/**
 * Default circuit breaker configuration values
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  enabled: false,
  failureThreshold: 5,
  failureWindow: 60000,
  resetTimeout: 30000,
  successThreshold: 2,
};

/**
 * Default log configuration values
 */
export const DEFAULT_LOG_CONFIG: LogConfig = {
  enabled: true,
  level: 'info',
};

/**
 * Default timeouts
 */
export const DEFAULT_CONNECTION_TIMEOUT = 10000;
export const DEFAULT_REQUEST_TIMEOUT = 30000;
