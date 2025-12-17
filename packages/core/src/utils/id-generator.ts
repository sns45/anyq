/**
 * @fileoverview ID generation utilities for anyq
 * @module @anyq/core/utils/id-generator
 */

/**
 * Generate a UUID v4
 *
 * Uses crypto.randomUUID if available, falls back to manual generation
 *
 * @returns UUID string
 */
export function generateUUID(): string {
  // Use native crypto if available (Node.js, modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a short unique ID
 *
 * Produces a ~11 character base36 string that's URL-safe
 *
 * @param prefix - Optional prefix for the ID
 * @returns Short unique ID
 *
 * @example
 * ```typescript
 * generateShortId() // "k5c8h3x2m9a"
 * generateShortId('msg') // "msg-k5c8h3x2m9a"
 * ```
 */
export function generateShortId(prefix?: string): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 7);
  const id = `${timestamp}${randomPart}`;

  return prefix ? `${prefix}-${id}` : id;
}

/**
 * Generate a message ID with timestamp and sequence
 *
 * Format: {timestamp}-{sequence}-{random}
 *
 * @param sequence - Optional sequence number
 * @returns Message ID
 *
 * @example
 * ```typescript
 * generateMessageId() // "1703001234567-0-a1b2c3"
 * generateMessageId(42) // "1703001234567-42-a1b2c3"
 * ```
 */
export function generateMessageId(sequence: number = 0): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${sequence}-${random}`;
}

/**
 * Generate a correlation ID for request tracing
 *
 * @returns Correlation ID with timestamp prefix
 */
export function generateCorrelationId(): string {
  return `corr-${generateShortId()}`;
}

/**
 * ID generator with configurable strategy
 */
export interface IdGenerator {
  /** Generate a new unique ID */
  generate(): string;
}

/**
 * Create an ID generator with a specific strategy
 *
 * @param strategy - ID generation strategy
 * @returns ID generator instance
 *
 * @example
 * ```typescript
 * const generator = createIdGenerator('uuid');
 * const id = generator.generate(); // "550e8400-e29b-41d4-a716-446655440000"
 * ```
 */
export function createIdGenerator(
  strategy: 'uuid' | 'short' | 'message' = 'uuid'
): IdGenerator {
  switch (strategy) {
    case 'uuid':
      return { generate: generateUUID };
    case 'short':
      return { generate: () => generateShortId() };
    case 'message':
      let sequence = 0;
      return {
        generate: () => generateMessageId(sequence++),
      };
    default:
      return { generate: generateUUID };
  }
}

/**
 * Validate if a string is a valid UUID v4
 *
 * @param id - String to validate
 * @returns True if valid UUID v4
 */
export function isValidUUID(id: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}
