/**
 * @fileoverview JSON serializer implementation
 * @module @anyq/core/serialization/json
 */

import type { ISerializer, SerializationFormat } from './types.js';
import { SerializationError } from '../types/errors.js';

/**
 * Options for JSON serializer
 */
export interface JsonSerializerOptions {
  /** Pretty print output. Default: false */
  pretty?: boolean;
  /** Custom replacer function for JSON.stringify */
  replacer?: (key: string, value: unknown) => unknown;
  /** Custom reviver function for JSON.parse */
  reviver?: (key: string, value: unknown) => unknown;
  /** Handle BigInt serialization. Default: true */
  handleBigInt?: boolean;
  /** Handle Date serialization. Default: true */
  handleDates?: boolean;
}

/**
 * Default replacer that handles BigInt and Date
 */
function defaultReplacer(
  options: JsonSerializerOptions
): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown): unknown => {
    // Handle BigInt
    if (options.handleBigInt !== false && typeof value === 'bigint') {
      return { __type: 'bigint', value: value.toString() };
    }

    // Handle Date (already handled by JSON.stringify, but we can customize)
    if (options.handleDates !== false && value instanceof Date) {
      return { __type: 'date', value: value.toISOString() };
    }

    return value;
  };
}

/**
 * Default reviver that handles BigInt and Date
 */
function defaultReviver(
  options: JsonSerializerOptions
): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown): unknown => {
    if (value && typeof value === 'object' && '__type' in value) {
      const typed = value as { __type: string; value: string };

      // Restore BigInt
      if (options.handleBigInt !== false && typed.__type === 'bigint') {
        return BigInt(typed.value);
      }

      // Restore Date
      if (options.handleDates !== false && typed.__type === 'date') {
        return new Date(typed.value);
      }
    }

    // Handle ISO date strings
    if (
      options.handleDates !== false &&
      typeof value === 'string' &&
      isISODateString(value)
    ) {
      return new Date(value);
    }

    return value;
  };
}

/**
 * Check if a string is an ISO 8601 date string
 */
function isISODateString(value: string): boolean {
  // Basic ISO 8601 date pattern check
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  if (!isoDateRegex.test(value)) {
    return false;
  }

  const date = new Date(value);
  return !isNaN(date.getTime());
}

/**
 * JSON serializer implementation
 *
 * Handles serialization and deserialization of JSON data with
 * optional support for BigInt, Date, and other special types.
 *
 * @example
 * ```typescript
 * const serializer = new JsonSerializer();
 *
 * const data = { name: 'test', amount: BigInt(123) };
 * const serialized = serializer.serialize(data);
 * const deserialized = serializer.deserialize(serialized);
 * ```
 */
export class JsonSerializer<T = unknown> implements ISerializer<T> {
  readonly format: SerializationFormat = 'json';
  private readonly options: JsonSerializerOptions;

  constructor(options: JsonSerializerOptions = {}) {
    this.options = {
      pretty: false,
      handleBigInt: true,
      handleDates: true,
      ...options,
    };
  }

  /**
   * Serialize a value to JSON string
   *
   * @param value - Value to serialize
   * @returns JSON string
   * @throws {SerializationError} If serialization fails
   */
  serialize(value: T): string {
    try {
      const replacer =
        this.options.replacer ?? defaultReplacer(this.options);
      const space = this.options.pretty ? 2 : undefined;

      return JSON.stringify(value, replacer as never, space);
    } catch (error) {
      throw new SerializationError(
        `Failed to serialize value to JSON: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Deserialize a JSON string to a value
   *
   * @param data - JSON string or Buffer
   * @returns Deserialized value
   * @throws {SerializationError} If deserialization fails
   */
  deserialize(data: Buffer | string): T {
    try {
      const jsonString = typeof data === 'string' ? data : data.toString('utf-8');
      const reviver = this.options.reviver ?? defaultReviver(this.options);

      return JSON.parse(jsonString, reviver as never) as T;
    } catch (error) {
      throw new SerializationError(
        `Failed to deserialize JSON: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Create a JSON serializer instance
 *
 * @param options - Serializer options
 * @returns JSON serializer
 */
export function createJsonSerializer<T = unknown>(
  options: JsonSerializerOptions = {}
): JsonSerializer<T> {
  return new JsonSerializer<T>(options);
}

/**
 * Default JSON serializer instance
 */
export const defaultJsonSerializer = new JsonSerializer();
