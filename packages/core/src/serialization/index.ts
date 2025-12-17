/**
 * @fileoverview Serialization exports for @anyq/core
 * @module @anyq/core/serialization
 */

export type {
  SerializationFormat,
  ISerializer,
  ISchemaSerializer,
  AvroConfig,
  SchemaRegistryConfig,
  SerializationConfig,
} from './types.js';

export {
  JsonSerializer,
  createJsonSerializer,
  defaultJsonSerializer,
  type JsonSerializerOptions,
} from './json.js';
