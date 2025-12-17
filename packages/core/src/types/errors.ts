/**
 * @fileoverview Error types for anyq
 * @module @anyq/core/types/errors
 */

/**
 * Base error class for all anyq errors
 */
export class AnyQError extends Error {
  /** Error code for programmatic handling */
  public readonly code: string;

  /** Whether this error is retryable */
  public readonly retryable: boolean;

  /** Additional error details */
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      code?: string;
      retryable?: boolean;
      cause?: Error;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AnyQError';
    this.code = options?.code ?? 'ANYQ_ERROR';
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Create error from unknown catch value
   */
  static from(error: unknown, defaultMessage = 'Unknown error'): AnyQError {
    if (error instanceof AnyQError) {
      return error;
    }
    if (error instanceof Error) {
      return new AnyQError(error.message, { cause: error });
    }
    return new AnyQError(String(error) || defaultMessage);
  }
}

/**
 * Connection-related errors
 */
export class ConnectionError extends AnyQError {
  constructor(message: string, cause?: Error) {
    super(message, {
      code: 'CONNECTION_ERROR',
      retryable: true,
      cause,
    });
    this.name = 'ConnectionError';
  }
}

/**
 * Serialization/deserialization errors
 */
export class SerializationError extends AnyQError {
  constructor(message: string, cause?: Error) {
    super(message, {
      code: 'SERIALIZATION_ERROR',
      retryable: false,
      cause,
    });
    this.name = 'SerializationError';
  }
}

/**
 * Publish operation errors
 */
export class PublishError extends AnyQError {
  constructor(
    message: string,
    options?: {
      retryable?: boolean;
      cause?: Error;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, {
      code: 'PUBLISH_ERROR',
      retryable: options?.retryable ?? true,
      cause: options?.cause,
      details: options?.details,
    });
    this.name = 'PublishError';
  }
}

/**
 * Consume operation errors
 */
export class ConsumeError extends AnyQError {
  constructor(message: string, cause?: Error) {
    super(message, {
      code: 'CONSUME_ERROR',
      retryable: true,
      cause,
    });
    this.name = 'ConsumeError';
  }
}

/**
 * Circuit breaker open error
 */
export class CircuitOpenError extends AnyQError {
  constructor(service?: string) {
    super(`Circuit breaker is open${service ? ` for ${service}` : ''}`, {
      code: 'CIRCUIT_OPEN',
      retryable: false,
    });
    this.name = 'CircuitOpenError';
  }
}

/**
 * Configuration validation errors
 */
export class ConfigurationError extends AnyQError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'CONFIGURATION_ERROR',
      retryable: false,
      details,
    });
    this.name = 'ConfigurationError';
  }
}

/**
 * Timeout errors
 */
export class TimeoutError extends AnyQError {
  constructor(operation: string, timeoutMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, {
      code: 'TIMEOUT_ERROR',
      retryable: true,
      details: { operation, timeoutMs },
    });
    this.name = 'TimeoutError';
  }
}

/**
 * Schema validation errors (for Avro, Protobuf, JSON Schema)
 */
export class SchemaValidationError extends AnyQError {
  /** Validation error details */
  public readonly validationErrors: unknown[];

  constructor(message: string, validationErrors: unknown[]) {
    super(message, {
      code: 'SCHEMA_VALIDATION_ERROR',
      retryable: false,
      details: { validationErrors },
    });
    this.name = 'SchemaValidationError';
    this.validationErrors = validationErrors;
  }
}

/**
 * Not implemented error for optional methods
 */
export class NotImplementedError extends AnyQError {
  constructor(method: string, adapter: string) {
    super(`Method '${method}' is not implemented for ${adapter} adapter`, {
      code: 'NOT_IMPLEMENTED',
      retryable: false,
      details: { method, adapter },
    });
    this.name = 'NotImplementedError';
  }
}
