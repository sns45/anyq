// Package pubsub implements the anyq producer/consumer adapters for Google Cloud
// Pub/Sub, built on cloud.google.com/go/pubsub (v1). It mirrors the TypeScript
// @anyq/google-pubsub package: the producer publishes to a topic and the
// consumer receives from a subscription via the streaming-pull Receive API.
//
// Capability notes (matching the shipped TS adapter):
//   - SupportsNativeDelay is false. Although Pub/Sub can express delayed
//     redelivery via subscription retry policy, the shipped adapter does not
//     override ParkMessage, so a Park decision downgrades to in-process retry
//     (handled by core.BaseConsumer.ApplyStrategy).
//   - DeadLetterMessage uses the base default (warn + Nack), letting Pub/Sub
//     redeliver per the subscription's dead-letter policy if one is configured
//     on the subscription itself.
package pubsub

import "github.com/sns45/anyq/go/core"

// ConnectionConfig holds Google Cloud Pub/Sub connection options. It mirrors the
// TypeScript PubSubConnectionConfig.
type ConnectionConfig struct {
	// ProjectID is the GCP project ID.
	ProjectID string
	// KeyFilename is the path to a service-account key file (optional when using
	// application default credentials).
	KeyFilename string
	// APIEndpoint overrides the API endpoint (used for the emulator).
	APIEndpoint string
	// EmulatorMode, when true together with APIEndpoint, sets PUBSUB_EMULATOR_HOST.
	EmulatorMode bool
}

// TopicConfig configures the producer's topic. Mirrors TS TopicConfig.
type TopicConfig struct {
	// Name is the topic ID (or full resource name).
	Name string
	// AutoCreate creates the topic on connect if it does not exist. Default: true.
	AutoCreate *bool
	// EnableMessageOrdering enables ordered delivery for messages with an ordering key.
	EnableMessageOrdering bool
}

// DeadLetterPolicyConfig mirrors TS subscription.deadLetterPolicy.
type DeadLetterPolicyConfig struct {
	// DeadLetterTopic is the dead-letter topic name (ID, not full resource name).
	DeadLetterTopic string
	// MaxDeliveryAttempts is the number of attempts before forwarding to the DLT.
	MaxDeliveryAttempts int
}

// RetryPolicyConfig mirrors TS subscription.retryPolicy (backoff in seconds).
type RetryPolicyConfig struct {
	MinimumBackoffSeconds int
	MaximumBackoffSeconds int
}

// FlowControlConfig mirrors TS subscription.flowControl.
type FlowControlConfig struct {
	// MaxMessages is the maximum number of outstanding (unacked) messages.
	MaxMessages int
	// MaxBytes is the maximum outstanding bytes.
	MaxBytes int
}

// SubscriptionConfig configures the consumer's subscription. Mirrors TS
// SubscriptionConfig.
type SubscriptionConfig struct {
	// Name is the subscription ID (or full resource name).
	Name string
	// AutoCreate creates the subscription (and topic) on connect if missing.
	// Default: true.
	AutoCreate *bool
	// AckDeadlineSeconds is the ack deadline. Default: 30.
	AckDeadlineSeconds int
	// ExactlyOnceDelivery enables exactly-once delivery.
	ExactlyOnceDelivery bool
	// DeadLetterPolicy configures Pub/Sub-native dead lettering.
	DeadLetterPolicy *DeadLetterPolicyConfig
	// RetryPolicy configures Pub/Sub-native redelivery backoff.
	RetryPolicy *RetryPolicyConfig
	// FlowControl configures receive flow control.
	FlowControl *FlowControlConfig
}

// BatchingConfig configures producer-side publish batching. Mirrors TS batching.
type BatchingConfig struct {
	// MaxMessages is the maximum messages in a batch. Default: 100.
	MaxMessages int
	// MaxBytes is the maximum batch size in bytes. Default: 1MB.
	MaxBytes int
	// MaxMilliseconds is the maximum delay before flushing a batch. Default: 10.
	MaxMilliseconds int
}

// ProducerConfig configures the Pub/Sub producer. Mirrors TS PubSubProducerConfig.
type ProducerConfig struct {
	core.BaseQueueConfig
	// Connection holds connection options.
	Connection ConnectionConfig
	// Topic holds topic options.
	Topic TopicConfig
	// Batching holds optional batching settings.
	Batching *BatchingConfig
}

// ConsumerConfig configures the Pub/Sub consumer. Mirrors TS PubSubConsumerConfig.
type ConsumerConfig struct {
	core.BaseQueueConfig
	// Connection holds connection options.
	Connection ConnectionConfig
	// Subscription holds subscription options.
	Subscription SubscriptionConfig
	// TopicName is the topic to bind to when auto-creating the subscription.
	TopicName string
}

// Default configuration values, mirroring TS PUBSUB_DEFAULTS.
const (
	defaultAckDeadlineSeconds   = 30
	defaultBatchMaxMessages     = 100
	defaultBatchMaxBytes        = 1024 * 1024 // 1MB
	defaultBatchMaxMilliseconds = 10
	defaultFlowControlMessages  = 1000
	defaultFlowControlBytes     = 100 * 1024 * 1024 // 100MB
)

// boolOr returns *p when set, else fallback.
func boolOr(p *bool, fallback bool) bool {
	if p == nil {
		return fallback
	}
	return *p
}
