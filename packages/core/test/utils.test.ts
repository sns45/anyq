/**
 * @fileoverview Utility tests
 */

import { describe, test, expect } from 'bun:test';
import {
  generateUUID,
  generateShortId,
  generateMessageId,
  isValidUUID,
  createIdGenerator,
  createLogger,
  exponentialBackoff,
  linearBackoff,
  fibonacciBackoff,
  calculateDelay,
} from '../src/index.js';

describe('ID Generation', () => {
  describe('generateUUID', () => {
    test('should generate valid UUID v4', () => {
      const uuid = generateUUID();
      expect(isValidUUID(uuid)).toBe(true);
    });

    test('should generate unique UUIDs', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID());
      }
      expect(uuids.size).toBe(100);
    });
  });

  describe('generateShortId', () => {
    test('should generate short ID', () => {
      const id = generateShortId();
      expect(id.length).toBeLessThan(20);
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    test('should include prefix when provided', () => {
      const id = generateShortId('msg');
      expect(id).toMatch(/^msg-/);
    });
  });

  describe('generateMessageId', () => {
    test('should generate message ID with timestamp', () => {
      const id = generateMessageId();
      const parts = id.split('-');
      expect(parts.length).toBe(3);
      expect(parseInt(parts[0])).toBeGreaterThan(0);
    });

    test('should include sequence number', () => {
      const id = generateMessageId(42);
      expect(id).toContain('-42-');
    });
  });

  describe('createIdGenerator', () => {
    test('should create UUID generator', () => {
      const generator = createIdGenerator('uuid');
      const id = generator.generate();
      expect(isValidUUID(id)).toBe(true);
    });

    test('should create short ID generator', () => {
      const generator = createIdGenerator('short');
      const id = generator.generate();
      expect(id.length).toBeLessThan(20);
    });

    test('should create message ID generator with sequence', () => {
      const generator = createIdGenerator('message');
      const id1 = generator.generate();
      const id2 = generator.generate();

      expect(id1).toContain('-0-');
      expect(id2).toContain('-1-');
    });
  });
});

describe('Logger', () => {
  test('should create logger with default options', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  test('should create no-op logger when disabled', () => {
    const logger = createLogger({ enabled: false });
    // Should not throw
    logger.debug('test');
    logger.info('test');
    logger.warn('test');
    logger.error('test');
  });

  test('should use custom logger when provided', () => {
    const messages: string[] = [];
    const customLogger = {
      debug: (msg: string) => messages.push(`DEBUG: ${msg}`),
      info: (msg: string) => messages.push(`INFO: ${msg}`),
      warn: (msg: string) => messages.push(`WARN: ${msg}`),
      error: (msg: string) => messages.push(`ERROR: ${msg}`),
    };

    const logger = createLogger({ logger: customLogger });
    logger.info('test message');

    expect(messages).toContain('INFO: test message');
  });
});

describe('Backoff Strategies', () => {
  const baseOptions = {
    initialDelayMs: 100,
    maxDelayMs: 10000,
    multiplier: 2,
    jitter: false,
  };

  describe('exponentialBackoff', () => {
    test('should calculate exponential delays', () => {
      expect(exponentialBackoff(1, baseOptions)).toBe(100);
      expect(exponentialBackoff(2, baseOptions)).toBe(200);
      expect(exponentialBackoff(3, baseOptions)).toBe(400);
      expect(exponentialBackoff(4, baseOptions)).toBe(800);
    });

    test('should cap at maxDelayMs', () => {
      expect(exponentialBackoff(100, baseOptions)).toBe(10000);
    });
  });

  describe('linearBackoff', () => {
    test('should calculate linear delays', () => {
      const options = { ...baseOptions, multiplier: 100 };
      expect(linearBackoff(1, options)).toBe(100);
      expect(linearBackoff(2, options)).toBe(200);
      expect(linearBackoff(3, options)).toBe(300);
    });
  });

  describe('fibonacciBackoff', () => {
    test('should calculate fibonacci delays', () => {
      // Fibonacci: 1, 1, 2, 3, 5, 8...
      // Scaled by initialDelayMs (100)
      expect(fibonacciBackoff(1, baseOptions)).toBe(100);
      expect(fibonacciBackoff(2, baseOptions)).toBe(100);
      expect(fibonacciBackoff(3, baseOptions)).toBe(200);
      expect(fibonacciBackoff(4, baseOptions)).toBe(300);
      expect(fibonacciBackoff(5, baseOptions)).toBe(500);
    });
  });

  describe('calculateDelay', () => {
    test('should use specified strategy', () => {
      expect(calculateDelay(3, { ...baseOptions, strategy: 'exponential' })).toBe(400);
      expect(calculateDelay(3, { ...baseOptions, strategy: 'constant' })).toBe(100);
    });

    test('should default to exponential', () => {
      expect(calculateDelay(2, baseOptions)).toBe(200);
    });
  });
});
