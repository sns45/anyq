// Package core defines the broker-agnostic interfaces, errors, retry
// strategies, backoff, and serialization helpers shared by every anyq adapter.
//
// core imports no broker SDKs: importing github.com/sns45/anyq/go/nats does not
// pull in the Kafka client, and vice versa.
package core

import "time"

// QueueDriver identifies a supported broker.
type QueueDriver string

const (
	DriverMemory          QueueDriver = "memory"
	DriverRedisStreams    QueueDriver = "redis-streams"
	DriverRabbitMQ        QueueDriver = "rabbitmq"
	DriverSQS             QueueDriver = "sqs"
	DriverSNS             QueueDriver = "sns"
	DriverGooglePubSub    QueueDriver = "google-pubsub"
	DriverKafka           QueueDriver = "kafka"
	DriverNATS            QueueDriver = "nats"
	DriverAzureServiceBus QueueDriver = "azure-servicebus"
)

// RetryConfig configures exponential backoff for transport-level resilience and
// for the RetryThenDeadLetter strategy.
type RetryConfig struct {
	// MaxRetries is the maximum number of retry attempts. Default: 3.
	MaxRetries int
	// InitialDelayMs is the initial delay in milliseconds. Default: 100.
	InitialDelayMs int
	// MaxDelayMs is the maximum delay in milliseconds. Default: 10000.
	MaxDelayMs int
	// Multiplier is the backoff multiplier. Default: 2.
	Multiplier float64
	// Jitter adds random jitter to prevent thundering herd. Default: true.
	Jitter bool
	// RetryableErrors are substrings that mark an error message as retryable.
	RetryableErrors []string
}

// CircuitBreakerConfig configures the connection-level circuit breaker.
type CircuitBreakerConfig struct {
	Enabled          bool
	FailureThreshold int
	FailureWindowMs  int
	ResetTimeoutMs   int
	SuccessThreshold int
}

// DeadLetterConfig configures dead-letter handling.
type DeadLetterConfig struct {
	Enabled             bool
	Destination         string
	MaxDeliveryAttempts int
	IncludeError        bool
}

// LogLevel enumerates logger verbosity levels.
type LogLevel string

const (
	LogDebug LogLevel = "debug"
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
)

// LogConfig configures logging.
type LogConfig struct {
	Enabled bool
	Level   LogLevel
	// Logger optionally supplies a custom logger implementation.
	Logger Logger
}

// BaseQueueConfig is shared configuration for every adapter. Adapters embed it
// in their own config structs.
type BaseQueueConfig struct {
	// Driver is the queue driver type (optional; adapters default it).
	Driver QueueDriver
	// ClientID identifies the client for logging/tracing.
	ClientID string
	// Retry configures transport-level retries and strategy backoff.
	Retry *RetryConfig
	// CircuitBreaker configures the connection-level circuit breaker.
	CircuitBreaker *CircuitBreakerConfig
	// DeadLetterQueue configures dead-letter behaviour.
	DeadLetterQueue *DeadLetterConfig
	// Logging configures logging.
	Logging *LogConfig
	// ConnectionTimeout is the connection timeout. Default: 10s.
	ConnectionTimeout time.Duration
	// RequestTimeout is the request timeout. Default: 30s.
	RequestTimeout time.Duration

	// Strategy is the per-message retry strategy. When nil, the adapter's legacy
	// catch-block behaviour is preserved (backward compatible).
	//
	// See the strategy factories in this package: RetryThenDeadLetter, LogAndSkip,
	// DeadLetterImmediate, BackpressurePause, LogAndFail, Custom.
	Strategy Strategy

	// AllowParkDowngrade controls what happens when a strategy might emit a Park
	// decision but the adapter has no native delayed-redelivery support. On such
	// adapters a Park downgrades to a blocking in-process retry (capped by
	// maxAttempts), which can stall the consumer and, on lease-based brokers,
	// duplicate the message when the lock/visibility window expires mid-sleep.
	//
	// When false (the Go default — fail loud), VerifyParkPolicy returns an error
	// from Connect so the caller must opt into the downgrade explicitly. When
	// true, the downgrade is allowed and logged once at startup.
	//
	// Note: the TypeScript port defaults this to "downgrade allowed" because it
	// has shipped releases; the Go module has no tagged release yet, so it
	// defaults to fail-loud to avoid carrying the footgun into v1.
	AllowParkDowngrade bool

	// OnError, when set, is invoked for observability on every non-ack strategy
	// outcome (this replaces the TypeScript consumer 'error' event).
	OnError func(err error)
}

// Default configuration values.
var (
	DefaultRetryConfig = RetryConfig{
		MaxRetries:     3,
		InitialDelayMs: 100,
		MaxDelayMs:     10000,
		Multiplier:     2,
		Jitter:         true,
	}

	DefaultCircuitBreakerConfig = CircuitBreakerConfig{
		Enabled:          false,
		FailureThreshold: 5,
		FailureWindowMs:  60000,
		ResetTimeoutMs:   30000,
		SuccessThreshold: 2,
	}

	DefaultLogConfig = LogConfig{
		Enabled: true,
		Level:   LogInfo,
	}
)

const (
	DefaultConnectionTimeout = 10 * time.Second
	DefaultRequestTimeout    = 30 * time.Second
)

// resolveRetryConfig merges the supplied partial RetryConfig over the defaults.
func resolveRetryConfig(c *RetryConfig) RetryConfig {
	out := DefaultRetryConfig
	if c == nil {
		return out
	}
	if c.MaxRetries != 0 {
		out.MaxRetries = c.MaxRetries
	}
	if c.InitialDelayMs != 0 {
		out.InitialDelayMs = c.InitialDelayMs
	}
	if c.MaxDelayMs != 0 {
		out.MaxDelayMs = c.MaxDelayMs
	}
	if c.Multiplier != 0 {
		out.Multiplier = c.Multiplier
	}
	// Jitter and RetryableErrors are taken verbatim when a config is supplied.
	out.Jitter = c.Jitter
	if c.RetryableErrors != nil {
		out.RetryableErrors = c.RetryableErrors
	}
	return out
}
