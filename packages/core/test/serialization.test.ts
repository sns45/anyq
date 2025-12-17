/**
 * @fileoverview Serialization tests
 */

import { describe, test, expect } from 'bun:test';
import {
  JsonSerializer,
  createJsonSerializer,
  SerializationError,
} from '../src/index.js';

describe('JsonSerializer', () => {
  test('should serialize and deserialize basic objects', () => {
    const serializer = new JsonSerializer();
    const data = { name: 'test', value: 42 };

    const serialized = serializer.serialize(data);
    expect(typeof serialized).toBe('string');

    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toEqual(data);
  });

  test('should serialize and deserialize arrays', () => {
    const serializer = new JsonSerializer();
    const data = [1, 2, 3, 'test'];

    const serialized = serializer.serialize(data);
    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toEqual(data);
  });

  test('should handle BigInt with special encoding', () => {
    const serializer = new JsonSerializer({ handleBigInt: true });
    const data = { amount: BigInt('9007199254740993') };

    const serialized = serializer.serialize(data);
    const deserialized = serializer.deserialize(serialized) as typeof data;

    expect(deserialized.amount).toBe(BigInt('9007199254740993'));
  });

  test('should handle Date with special encoding', () => {
    const serializer = new JsonSerializer({ handleDates: true });
    const date = new Date('2024-01-15T10:30:00.000Z');
    const data = { createdAt: date };

    const serialized = serializer.serialize(data);
    const deserialized = serializer.deserialize(serialized) as typeof data;

    expect(deserialized.createdAt).toBeInstanceOf(Date);
    expect(deserialized.createdAt.toISOString()).toBe(date.toISOString());
  });

  test('should deserialize from Buffer', () => {
    const serializer = new JsonSerializer();
    const data = { name: 'test' };
    const buffer = Buffer.from(JSON.stringify(data), 'utf-8');

    const deserialized = serializer.deserialize(buffer);
    expect(deserialized).toEqual(data);
  });

  test('should throw SerializationError on invalid JSON', () => {
    const serializer = new JsonSerializer();

    expect(() => {
      serializer.deserialize('not valid json');
    }).toThrow(SerializationError);
  });

  test('should throw SerializationError on circular reference', () => {
    const serializer = new JsonSerializer();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => {
      serializer.serialize(circular);
    }).toThrow(SerializationError);
  });

  test('should support pretty printing', () => {
    const serializer = new JsonSerializer({ pretty: true });
    const data = { name: 'test' };

    const serialized = serializer.serialize(data);
    expect(serialized).toContain('\n');
    expect(serialized).toContain('  ');
  });

  test('should preserve nested objects', () => {
    const serializer = new JsonSerializer();
    const data = {
      user: {
        name: 'John',
        address: {
          city: 'NYC',
          zip: '10001',
        },
      },
      tags: ['a', 'b', 'c'],
    };

    const serialized = serializer.serialize(data);
    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toEqual(data);
  });
});

describe('createJsonSerializer', () => {
  test('should create serializer with options', () => {
    const serializer = createJsonSerializer({ pretty: true });
    expect(serializer).toBeInstanceOf(JsonSerializer);
    expect(serializer.format).toBe('json');
  });
});
