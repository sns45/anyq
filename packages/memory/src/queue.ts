/**
 * @fileoverview In-memory queue storage
 * @module @anyq/memory/queue
 */

import type { MessageHeaders, ProviderMetadata } from '@anyq/core';
import { generateMessageId } from '@anyq/core';

/**
 * Internal message storage format
 */
export interface StoredMessage<T = unknown> {
  id: string;
  body: T;
  key?: string;
  headers: MessageHeaders;
  timestamp: Date;
  deliveryAttempt: number;
  acknowledged: boolean;
  requeued: boolean;
  deadLettered: boolean;
}

/**
 * In-memory queue implementation
 *
 * Provides a simple FIFO queue for testing and development.
 */
export class MemoryQueue<T = unknown> {
  private messages: StoredMessage<T>[] = [];
  private processing: Map<string, StoredMessage<T>> = new Map();
  private readonly queueName: string;
  private readonly maxMessages: number;
  private readonly maxAgeMs: number;

  constructor(
    queueName: string = 'default',
    options: { maxMessages?: number; maxAgeMs?: number } = {}
  ) {
    this.queueName = queueName;
    this.maxMessages = options.maxMessages ?? 0;
    this.maxAgeMs = options.maxAgeMs ?? 0;
  }

  /**
   * Add a message to the queue
   */
  enqueue(
    body: T,
    options: { key?: string; headers?: MessageHeaders } = {}
  ): string {
    // Clean up old messages if needed
    this.cleanup();

    const id = generateMessageId();
    const message: StoredMessage<T> = {
      id,
      body,
      key: options.key,
      headers: options.headers ?? {},
      timestamp: new Date(),
      deliveryAttempt: 0,
      acknowledged: false,
      requeued: false,
      deadLettered: false,
    };

    this.messages.push(message);

    // Enforce max messages limit
    if (this.maxMessages > 0 && this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    return id;
  }

  /**
   * Get the next message from the queue
   */
  dequeue(): StoredMessage<T> | undefined {
    this.cleanup();

    const message = this.messages.shift();
    if (!message) {
      return undefined;
    }

    message.deliveryAttempt++;
    this.processing.set(message.id, message);
    return message;
  }

  /**
   * Peek at the next message without removing it
   */
  peek(): StoredMessage<T> | undefined {
    return this.messages[0];
  }

  /**
   * Get multiple messages from the queue
   */
  dequeueBatch(count: number): StoredMessage<T>[] {
    this.cleanup();

    const messages: StoredMessage<T>[] = [];
    for (let i = 0; i < count; i++) {
      const message = this.dequeue();
      if (!message) break;
      messages.push(message);
    }
    return messages;
  }

  /**
   * Acknowledge a message
   */
  ack(messageId: string): boolean {
    const message = this.processing.get(messageId);
    if (!message) {
      return false;
    }

    message.acknowledged = true;
    this.processing.delete(messageId);
    return true;
  }

  /**
   * Negative acknowledge - requeue or discard
   */
  nack(messageId: string, requeue: boolean = true): boolean {
    const message = this.processing.get(messageId);
    if (!message) {
      return false;
    }

    this.processing.delete(messageId);

    if (requeue) {
      message.requeued = true;
      this.messages.unshift(message);
    }

    return true;
  }

  /**
   * Move message to dead letter queue
   */
  deadLetter(
    messageId: string,
    dlq: MemoryQueue<unknown>,
    error?: Error
  ): boolean {
    const message = this.processing.get(messageId);
    if (!message) {
      return false;
    }

    this.processing.delete(messageId);

    // Add error info to headers
    const dlqHeaders: MessageHeaders = {
      ...message.headers,
      'x-original-queue': this.queueName,
      'x-death-reason': error?.message ?? 'max retries exceeded',
      'x-death-time': new Date().toISOString(),
      'x-delivery-attempts': String(message.deliveryAttempt),
    };

    dlq.enqueue(message.body as unknown, {
      key: message.key,
      headers: dlqHeaders,
    });

    return true;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.messages.length;
  }

  /**
   * Get number of messages being processed
   */
  processingCount(): number {
    return this.processing.size;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
    this.processing.clear();
  }

  /**
   * Get all messages (for debugging)
   */
  getAll(): StoredMessage<T>[] {
    return [...this.messages];
  }

  /**
   * Clean up expired messages
   */
  private cleanup(): void {
    if (this.maxAgeMs <= 0) {
      return;
    }

    const now = Date.now();
    this.messages = this.messages.filter(
      (msg) => now - msg.timestamp.getTime() < this.maxAgeMs
    );
  }

  /**
   * Create provider metadata for a message
   */
  createMetadata(): ProviderMetadata {
    return {
      provider: 'memory',
      memory: {
        queueName: this.queueName,
      },
    };
  }
}
