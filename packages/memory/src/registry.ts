/**
 * @fileoverview Global queue registry for memory adapter
 * @module @anyq/memory/registry
 *
 * Allows multiple producers and consumers to share the same in-memory queues.
 */

import { MemoryQueue } from './queue.js';

/**
 * Global registry of in-memory queues
 */
const queues = new Map<string, MemoryQueue<unknown>>();

/**
 * Get a queue by name
 */
export function getQueue<T = unknown>(name: string): MemoryQueue<T> | undefined {
  return queues.get(name) as MemoryQueue<T> | undefined;
}

/**
 * Register a queue
 */
export function registerQueue<T = unknown>(
  name: string,
  queue: MemoryQueue<T>
): void {
  queues.set(name, queue as MemoryQueue<unknown>);
}

/**
 * Remove a queue from registry
 */
export function unregisterQueue(name: string): boolean {
  return queues.delete(name);
}

/**
 * Clear all queues
 */
export function clearAllQueues(): void {
  for (const queue of queues.values()) {
    queue.clear();
  }
  queues.clear();
}

/**
 * Get all queue names
 */
export function getQueueNames(): string[] {
  return Array.from(queues.keys());
}

/**
 * Get queue statistics
 */
export function getQueueStats(): Record<
  string,
  { size: number; processing: number }
> {
  const stats: Record<string, { size: number; processing: number }> = {};
  for (const [name, queue] of queues.entries()) {
    stats[name] = {
      size: queue.size(),
      processing: queue.processingCount(),
    };
  }
  return stats;
}
