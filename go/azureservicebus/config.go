// Package azureservicebus implements the anyq Producer/Consumer interfaces for
// Azure Service Bus.
//
// Capability notes:
//   - SupportsNativeDelay is true: a strategy Park is honoured natively by
//     re-sending the message with ScheduledEnqueueTime = now + delay and
//     completing the original (see Consumer.ParkMessage). This avoids the
//     downgrade footgun — ASB lock duration defaults to 1 minute (max 5), so a
//     multi-minute in-process park sleep would block the consumer and duplicate
//     the message when the lock expires mid-sleep.
//   - Dead-letter uses the base default hook (warn + nack(false)) for the
//     strategy DeadLetter action; the broker routes to its native dead-letter
//     sub-queue once MaxDeliveryCount is exceeded. Native dead-lettering is also
//     available explicitly via Consumer.DeadLetterNative.
package azureservicebus

import (
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"

	"github.com/sns45/anyq/go/core"
)

// ReceiveMode mirrors the TS receiveMode option.
type ReceiveMode string

const (
	// ReceiveModePeekLock locks messages as they are received; they must be
	// settled (complete/abandon/dead-letter). This is the default.
	ReceiveModePeekLock ReceiveMode = "peekLock"
	// ReceiveModeReceiveAndDelete deletes messages as they are received.
	ReceiveModeReceiveAndDelete ReceiveMode = "receiveAndDelete"
)

// ConnectionConfig holds Azure Service Bus connection settings.
type ConnectionConfig struct {
	// ConnectionString is the Service Bus connection string (includes endpoint,
	// access key, etc.). Takes precedence over FullyQualifiedNamespace.
	ConnectionString string
	// FullyQualifiedNamespace is the namespace host (e.g. my-ns.servicebus.windows.net).
	// Reserved for AAD-credential connections; the shipped TS adapter only uses
	// the connection string.
	FullyQualifiedNamespace string
}

// QueueConfig identifies a queue.
type QueueConfig struct {
	// Name is the queue name.
	Name string
}

// TopicConfig identifies a topic (producer-side).
type TopicConfig struct {
	// Name is the topic name.
	Name string
}

// SubscriptionConfig identifies a topic subscription (consumer-side).
type SubscriptionConfig struct {
	// TopicName is the topic name.
	TopicName string
	// SubscriptionName is the subscription name.
	SubscriptionName string
}

// ReceiverOptions holds consumer receiver options.
type ReceiverOptions struct {
	// ReceiveMode is "peekLock" (default) or "receiveAndDelete".
	ReceiveMode ReceiveMode
	// MaxAutoLockRenewalDurationMs is the max auto lock-renewal duration in ms.
	MaxAutoLockRenewalDurationMs int
	// DeadLetterSubQueue, when true, connects the receiver to the dead-letter
	// sub-queue of the queue/subscription.
	DeadLetterSubQueue bool
}

// SenderOptions holds producer sender options.
type SenderOptions struct {
	// UseTopic sends via the configured topic instead of the queue.
	UseTopic bool
}

// Config configures the Azure Service Bus adapter. It embeds core.BaseQueueConfig.
type Config struct {
	core.BaseQueueConfig

	// Connection holds the connection configuration.
	Connection ConnectionConfig

	// Queue holds the queue configuration (direct queue send/receive).
	Queue *QueueConfig

	// Topic holds the topic configuration (producer topic send).
	Topic *TopicConfig

	// Subscription holds the subscription configuration (consumer subscription receive).
	Subscription *SubscriptionConfig

	// Sender holds producer sender options.
	Sender SenderOptions

	// Receiver holds consumer receiver options.
	Receiver ReceiverOptions

	// Prefetch is the receiver prefetch count (number of messages buffered).
	Prefetch int

	// MaxConcurrentCalls is the number of messages processed concurrently.
	// Default: 10.
	MaxConcurrentCalls int
}

// Default values mirroring the TS SERVICEBUS_DEFAULTS.
const (
	defaultMaxConcurrentCalls           = 10
	defaultMaxAutoLockRenewalDurationMs = 300000 // 5 minutes
)

// senderEntity returns the entity path the producer publishes to (topic or queue).
func (c Config) senderEntity() string {
	if c.Sender.UseTopic && c.Topic != nil {
		return c.Topic.Name
	}
	if c.Topic != nil {
		return c.Topic.Name
	}
	if c.Queue != nil {
		return c.Queue.Name
	}
	return ""
}

// parkEntity returns the entity a parked message is re-sent to so it re-arrives
// at this consumer: the topic for a subscription consumer, otherwise the queue.
func (c Config) parkEntity() string {
	if c.Subscription != nil {
		return c.Subscription.TopicName
	}
	if c.Queue != nil {
		return c.Queue.Name
	}
	return ""
}

// maxConcurrentCalls returns the concurrency, defaulting to 10.
func (c Config) maxConcurrentCalls() int {
	if c.MaxConcurrentCalls > 0 {
		return c.MaxConcurrentCalls
	}
	return defaultMaxConcurrentCalls
}

// receiveMode returns the resolved SDK receive mode.
func (c Config) receiveMode() azservicebus.ReceiveMode {
	if c.Receiver.ReceiveMode == ReceiveModeReceiveAndDelete {
		return azservicebus.ReceiveModeReceiveAndDelete
	}
	return azservicebus.ReceiveModePeekLock
}
