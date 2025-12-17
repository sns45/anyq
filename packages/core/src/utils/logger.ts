/**
 * @fileoverview Logger utility for anyq
 * @module @anyq/core/utils/logger
 */

import type { Logger, LogLevel, LogConfig } from '../types/config.js';
import { DEFAULT_LOG_CONFIG } from '../types/config.js';

/**
 * Log level priority map
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Console logger implementation
 */
class ConsoleLogger implements Logger {
  private readonly prefix: string;
  private readonly level: LogLevel;

  constructor(prefix: string = 'anyq', level: LogLevel = 'info') {
    this.prefix = prefix;
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${this.prefix}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }
}

/**
 * No-op logger for when logging is disabled
 */
class NoOpLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/**
 * Create a logger instance
 *
 * @param config - Logger configuration
 * @param prefix - Logger prefix (e.g., adapter name)
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger({ enabled: true, level: 'debug' }, 'kafka');
 * logger.info('Connected to broker', { broker: 'localhost:9092' });
 * ```
 */
export function createLogger(
  config: Partial<LogConfig> = {},
  prefix: string = 'anyq'
): Logger {
  const mergedConfig = {
    ...DEFAULT_LOG_CONFIG,
    ...config,
  };

  // Return custom logger if provided
  if (mergedConfig.logger) {
    return mergedConfig.logger;
  }

  // Return no-op logger if disabled
  if (!mergedConfig.enabled) {
    return new NoOpLogger();
  }

  return new ConsoleLogger(prefix, mergedConfig.level);
}

/**
 * Create a child logger with a new prefix
 *
 * @param parent - Parent logger
 * @param childPrefix - Additional prefix for child logger
 * @returns New logger with combined prefix
 */
export function createChildLogger(
  parent: Logger,
  childPrefix: string
): Logger {
  return {
    debug: (message, meta) => parent.debug(`[${childPrefix}] ${message}`, meta),
    info: (message, meta) => parent.info(`[${childPrefix}] ${message}`, meta),
    warn: (message, meta) => parent.warn(`[${childPrefix}] ${message}`, meta),
    error: (message, meta) => parent.error(`[${childPrefix}] ${message}`, meta),
  };
}

export { ConsoleLogger, NoOpLogger };
