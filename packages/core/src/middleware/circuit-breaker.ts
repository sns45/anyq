/**
 * @fileoverview Circuit breaker implementation
 * @module @anyq/core/middleware/circuit-breaker
 */

import { CircuitOpenError } from '../types/errors.js';
import type { CircuitBreakerConfig } from '../types/config.js';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../types/config.js';

/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker metrics
 */
export interface CircuitBreakerMetrics {
  /** Current circuit state */
  state: CircuitState;
  /** Recent failures within window */
  failures: number;
  /** Consecutive successes in half-open state */
  successes: number;
  /** Last failure timestamp */
  lastFailureTime?: Date;
  /** Total requests through circuit */
  totalRequests: number;
  /** Total failures */
  totalFailures: number;
}

/**
 * Circuit breaker implementation
 *
 * Protects services from cascading failures by failing fast
 * when a downstream service is unavailable.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail immediately
 * - HALF-OPEN: Testing if service recovered
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   enabled: true,
 *   failureThreshold: 5,
 *   resetTimeout: 30000,
 * });
 *
 * try {
 *   await breaker.execute(() => publishMessage());
 * } catch (error) {
 *   if (error instanceof CircuitOpenError) {
 *     // Fast fail - service is down
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = [];
  private successes = 0;
  private lastFailureTime?: number;
  private totalRequests = 0;
  private totalFailures = 0;

  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config,
    };
  }

  /**
   * Execute an operation through the circuit breaker
   *
   * @param operation - Async operation to execute
   * @returns Result of the operation
   * @throws {CircuitOpenError} If circuit is open
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return operation();
    }

    this.totalRequests++;
    this.cleanOldFailures();

    // Check if circuit is open
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new CircuitOpenError();
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    return this.state === 'open';
  }

  /**
   * Check if circuit is closed (healthy)
   */
  isClosed(): boolean {
    return this.state === 'closed';
  }

  /**
   * Get circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    this.cleanOldFailures();
    return {
      state: this.state,
      failures: this.failures.length,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime
        ? new Date(this.lastFailureTime)
        : undefined,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
    };
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.successes = 0;
    this.lastFailureTime = undefined;
  }

  /**
   * Manually trip the circuit breaker to open state
   */
  trip(): void {
    this.state = 'open';
    this.lastFailureTime = Date.now();
  }

  /**
   * Handle successful operation
   */
  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.state = 'closed';
        this.failures = [];
        this.successes = 0;
      }
    } else if (this.state === 'closed') {
      // Reset successes counter on successful operation in closed state
      this.successes = 0;
    }
  }

  /**
   * Handle failed operation
   */
  private onFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.lastFailureTime = now;
    this.totalFailures++;

    if (this.state === 'half-open') {
      // Any failure in half-open state trips the circuit
      this.state = 'open';
      this.successes = 0;
    } else if (this.state === 'closed') {
      this.cleanOldFailures();
      if (this.failures.length >= this.config.failureThreshold) {
        this.state = 'open';
      }
    }
  }

  /**
   * Remove failures outside the time window
   */
  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.config.failureWindow;
    this.failures = this.failures.filter((time) => time > cutoff);
  }

  /**
   * Check if enough time has passed to attempt reset
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) {
      return true;
    }
    return Date.now() - this.lastFailureTime >= this.config.resetTimeout;
  }
}
