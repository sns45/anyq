package core

import (
	"errors"
	"fmt"
)

// ErrNotSupported is returned by optional Message/Consumer operations that a
// given broker does not implement (e.g. ExtendDeadline on Kafka).
var ErrNotSupported = errors.New("operation not supported by this adapter")

// AnyQError is the base error type for all anyq errors. It carries a code and a
// retryable flag consumed by the default isRetryable predicate.
type AnyQError struct {
	Message   string
	Code      string
	Retryable bool
	Cause     error
	Details   map[string]any
}

func (e *AnyQError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

// Unwrap exposes the wrapped cause to errors.Is / errors.As.
func (e *AnyQError) Unwrap() error { return e.Cause }

// AsAnyQError reports whether err is (or wraps) an *AnyQError.
func AsAnyQError(err error) (*AnyQError, bool) {
	var ae *AnyQError
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}

// NewError builds a generic AnyQError.
func NewError(message string, code string, retryable bool, cause error) *AnyQError {
	if code == "" {
		code = "ANYQ_ERROR"
	}
	return &AnyQError{Message: message, Code: code, Retryable: retryable, Cause: cause}
}

// NewConnectionError builds a retryable connection error.
func NewConnectionError(message string, cause error) *AnyQError {
	return &AnyQError{Message: message, Code: "CONNECTION_ERROR", Retryable: true, Cause: cause}
}

// NewSerializationError builds a non-retryable serialization error.
func NewSerializationError(message string, cause error) *AnyQError {
	return &AnyQError{Message: message, Code: "SERIALIZATION_ERROR", Retryable: false, Cause: cause}
}

// NewPublishError builds a publish error (retryable by default).
func NewPublishError(message string, retryable bool, cause error) *AnyQError {
	return &AnyQError{Message: message, Code: "PUBLISH_ERROR", Retryable: retryable, Cause: cause}
}

// NewConsumeError builds a retryable consume error.
func NewConsumeError(message string, cause error) *AnyQError {
	return &AnyQError{Message: message, Code: "CONSUME_ERROR", Retryable: true, Cause: cause}
}

// NewConfigurationError builds a non-retryable configuration error.
func NewConfigurationError(message string, details map[string]any) *AnyQError {
	return &AnyQError{Message: message, Code: "CONFIGURATION_ERROR", Retryable: false, Details: details}
}

// NewTimeoutError builds a retryable timeout error.
func NewTimeoutError(operation string, timeoutMs int) *AnyQError {
	return &AnyQError{
		Message:   fmt.Sprintf("operation %q timed out after %dms", operation, timeoutMs),
		Code:      "TIMEOUT_ERROR",
		Retryable: true,
		Details:   map[string]any{"operation": operation, "timeoutMs": timeoutMs},
	}
}

// NewNotImplementedError builds a non-retryable not-implemented error.
func NewNotImplementedError(method, adapter string) *AnyQError {
	return &AnyQError{
		Message:   fmt.Sprintf("method %q is not implemented for %s adapter", method, adapter),
		Code:      "NOT_IMPLEMENTED",
		Retryable: false,
		Details:   map[string]any{"method": method, "adapter": adapter},
	}
}
