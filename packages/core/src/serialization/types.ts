/**
 * @fileoverview Serialization type definitions
 * @module @anyq/core/serialization/types
 */

/**
 * Supported serialization formats
 */
export type SerializationFormat = 'json' | 'avro' | 'protobuf' | 'raw';

/**
 * Serializer interface
 *
 * Implementations must handle serialization and deserialization
 * of message bodies for a specific format.
 */
export interface ISerializer<T = unknown> {
  /** Serialization format identifier */
  readonly format: SerializationFormat;

  /**
   * Serialize a value to bytes/string
   *
   * @param value - Value to serialize
   * @returns Serialized data
   * @throws {SerializationError} If serialization fails
   */
  serialize(value: T): Buffer | string;

  /**
   * Deserialize bytes/string to a value
   *
   * @param data - Serialized data
   * @returns Deserialized value
   * @throws {SerializationError} If deserialization fails
   */
  deserialize(data: Buffer | string): T;
}

/**
 * Schema-based serializer interface (for Avro, Protobuf, JSON Schema)
 */
export interface ISchemaSerializer<T = unknown> extends ISerializer<T> {
  /**
   * Get the schema definition
   */
  getSchema(): unknown;

  /**
   * Validate a value against the schema
   *
   * @param value - Value to validate
   * @returns True if valid
   */
  validate(value: unknown): value is T;

  /**
   * Get validation errors for a value
   *
   * @param value - Value to validate
   * @returns Array of validation errors, empty if valid
   */
  getValidationErrors(value: unknown): string[];
}

/**
 * Avro-specific configuration
 */
export interface AvroConfig {
  /** Avro schema definition */
  schema: Record<string, unknown>;
  /** Reader schema for schema evolution */
  readerSchema?: Record<string, unknown>;
  /** Use Confluent wire format (magic byte + schema ID) */
  confluentWireFormat?: boolean;
  /** Logical type handling */
  logicalTypes?: {
    date?: 'Date' | 'number' | 'string';
    decimal?: 'bigint' | 'number' | 'string';
    uuid?: 'string';
  };
}

/**
 * Schema Registry configuration
 */
export interface SchemaRegistryConfig {
  /** Schema Registry URL */
  url: string;
  /** Subject name strategy */
  subjectNameStrategy?: 'topic' | 'record' | 'topic-record';
  /** Auto-register schemas */
  autoRegisterSchemas?: boolean;
  /** Compatibility mode */
  compatibilityMode?: 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';
  /** Basic auth credentials */
  auth?: {
    username: string;
    password: string;
  };
}

/**
 * Serialization configuration for queue adapters
 */
export interface SerializationConfig {
  /** Serialization format */
  type: SerializationFormat;
  /** Schema Registry config (for Avro) */
  schemaRegistry?: SchemaRegistryConfig;
  /** Avro-specific config */
  avro?: AvroConfig;
  /** Custom serializer instance */
  serializer?: ISerializer;
}
