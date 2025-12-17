/**
 * @fileoverview Memory adapter configuration
 * @module @anyq/memory/config
 */

import type { BaseQueueConfig } from '@anyq/core';

/**
 * Memory queue configuration
 */
export interface MemoryQueueConfig extends BaseQueueConfig {
  driver: 'memory';

  /** Queue name */
  queueName?: string;

  /** Maximum messages to store (0 = unlimited) */
  maxMessages?: number;

  /** Maximum message age in ms (0 = unlimited) */
  maxAgeMs?: number;

  /** Enable message persistence to disk (for debugging) */
  persist?: boolean;

  /** Persistence file path */
  persistPath?: string;
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: Partial<MemoryQueueConfig> = {
  driver: 'memory',
  queueName: 'default',
  maxMessages: 0,
  maxAgeMs: 0,
  persist: false,
};
