/**
 * @fileoverview Circuit breaker tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CircuitBreaker, CircuitOpenError } from '../src/index.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      enabled: true,
      failureThreshold: 3,
      failureWindow: 10000,
      resetTimeout: 1000,
      successThreshold: 2,
    });
  });

  test('should start in closed state', () => {
    expect(breaker.getState()).toBe('closed');
    expect(breaker.isClosed()).toBe(true);
    expect(breaker.isOpen()).toBe(false);
  });

  test('should execute operations when closed', async () => {
    const result = await breaker.execute(async () => 'success');
    expect(result).toBe('success');
  });

  test('should open circuit after failure threshold', async () => {
    const failingOperation = async () => {
      throw new Error('Service unavailable');
    };

    // Trigger failures up to threshold
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(failingOperation);
      } catch {
        // Expected
      }
    }

    expect(breaker.getState()).toBe('open');
    expect(breaker.isOpen()).toBe(true);
  });

  test('should throw CircuitOpenError when open', async () => {
    // Force circuit open
    breaker.trip();

    expect(breaker.isOpen()).toBe(true);

    try {
      await breaker.execute(async () => 'success');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
    }
  });

  test('should transition to half-open after reset timeout', async () => {
    // Force circuit open
    breaker.trip();
    expect(breaker.isOpen()).toBe(true);

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Next execution should transition to half-open and execute
    const result = await breaker.execute(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  test('should close circuit after success threshold in half-open', async () => {
    // Create breaker with short reset timeout
    breaker = new CircuitBreaker({
      enabled: true,
      failureThreshold: 2,
      failureWindow: 10000,
      resetTimeout: 100,
      successThreshold: 2,
    });

    // Trip the circuit
    breaker.trip();

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Execute successful operations to close circuit
    await breaker.execute(async () => 'success1');
    await breaker.execute(async () => 'success2');

    expect(breaker.getState()).toBe('closed');
    expect(breaker.isClosed()).toBe(true);
  });

  test('should return to open from half-open on failure', async () => {
    breaker = new CircuitBreaker({
      enabled: true,
      failureThreshold: 2,
      failureWindow: 10000,
      resetTimeout: 100,
      successThreshold: 2,
    });

    // Trip the circuit
    breaker.trip();

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Fail in half-open state
    try {
      await breaker.execute(async () => {
        throw new Error('Still failing');
      });
    } catch {
      // Expected
    }

    expect(breaker.getState()).toBe('open');
  });

  test('should track metrics', async () => {
    // Execute some operations
    await breaker.execute(async () => 'success');

    try {
      await breaker.execute(async () => {
        throw new Error('fail');
      });
    } catch {
      // Expected
    }

    const metrics = breaker.getMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.totalFailures).toBe(1);
    expect(metrics.state).toBe('closed');
  });

  test('should be disabled when enabled=false', async () => {
    breaker = new CircuitBreaker({ enabled: false });

    // Even after many failures, circuit should not open
    for (let i = 0; i < 10; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error('fail');
        });
      } catch {
        // Expected
      }
    }

    // Next call should still go through
    const result = await breaker.execute(async () => 'success');
    expect(result).toBe('success');
  });

  test('should reset manually', async () => {
    breaker.trip();
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();
    expect(breaker.isClosed()).toBe(true);

    const result = await breaker.execute(async () => 'success');
    expect(result).toBe('success');
  });
});
