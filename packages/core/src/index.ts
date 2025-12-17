/**
 * @fileoverview Main entry point for @anyq/core
 * @module @anyq/core
 *
 * @example
 * ```typescript
 * import {
 *   type IProducer,
 *   type IConsumer,
 *   type IMessage,
 *   CircuitBreaker,
 *   withRetry,
 *   createLogger,
 * } from '@anyq/core';
 * ```
 */

// Re-export all types
export * from './types/index.js';

// Re-export middleware
export * from './middleware/index.js';

// Re-export utilities
export * from './utils/index.js';

// Re-export serialization
export * from './serialization/index.js';

// Re-export base classes
export * from './base/index.js';
