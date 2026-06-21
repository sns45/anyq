package core

import (
	"context"
	"time"
)

// MessageHeaders are message headers/attributes. Values are bytes to match
// brokers that carry binary header values.
type MessageHeaders map[string][]byte

// Provider-specific metadata structs mirror the TypeScript ProviderMetadata.

type KafkaMetadata struct {
	Topic         string
	Partition     int
	Offset        string
	HighWatermark string
	Key           string
}

type SQSMetadata struct {
	QueueURL                         string
	ReceiptHandle                    string
	ApproximateReceiveCount          int
	SentTimestamp                    time.Time
	ApproximateFirstReceiveTimestamp time.Time
	MessageGroupID                   string
	SequenceNumber                   string
}

type RabbitMQMetadata struct {
	Exchange    string
	RoutingKey  string
	ConsumerTag string
	DeliveryTag uint64
	Redelivered bool
}

type GooglePubSubMetadata struct {
	Subscription string
	AckID        string
	PublishTime  time.Time
	OrderingKey  string
}

type AzureServiceBusMetadata struct {
	SequenceNumber int64
	EnqueuedTime   time.Time
	LockedUntil    time.Time
	SessionID      string
	PartitionKey   string
}

type RedisStreamsMetadata struct {
	Stream        string
	EntryID       string
	ConsumerGroup string
	Consumer      string
	IdleTimeMs    int64
}

type NATSMetadata struct {
	Stream          string
	Subject         string
	Sequence        uint64
	Redelivered     bool
	RedeliveryCount int
}

type MemoryMetadata struct {
	QueueName string
}

// ProviderMetadata carries the driver type plus optional broker-specific detail.
type ProviderMetadata struct {
	Provider        QueueDriver
	Kafka           *KafkaMetadata
	SQS             *SQSMetadata
	RabbitMQ        *RabbitMQMetadata
	GooglePubSub    *GooglePubSubMetadata
	AzureServiceBus *AzureServiceBusMetadata
	RedisStreams    *RedisStreamsMetadata
	NATS            *NATSMetadata
	Memory          *MemoryMetadata
}

// Message is the universal message interface. The body is raw bytes; decoding to
// a typed value is the handler's concern (see the serialization helpers).
type Message interface {
	ID() string
	Body() []byte
	Key() string
	Headers() MessageHeaders
	Timestamp() time.Time
	// DeliveryAttempt is the 1-based delivery attempt count.
	DeliveryAttempt() int
	Metadata() ProviderMetadata

	// Ack acknowledges successful processing (commit/delete/ack per broker).
	Ack(ctx context.Context) error
	// Nack negatively acknowledges; requeue requests redelivery where supported.
	Nack(ctx context.Context, requeue bool) error
	// ExtendDeadline extends the processing deadline where supported, else
	// returns ErrNotSupported.
	ExtendDeadline(ctx context.Context, d time.Duration) error

	// Raw is the underlying provider message (escape hatch).
	Raw() any
}

// MessageParams are the inputs to NewMessage. Adapters build one per delivery.
type MessageParams struct {
	ID              string
	Body            []byte
	Key             string
	Headers         MessageHeaders
	Timestamp       time.Time
	DeliveryAttempt int
	Metadata        ProviderMetadata
	Raw             any

	OnAck            func(ctx context.Context) error
	OnNack           func(ctx context.Context, requeue bool) error
	OnExtendDeadline func(ctx context.Context, d time.Duration) error
}

// baseMessage is the default Message implementation backed by callbacks.
type baseMessage struct {
	params MessageParams
}

// NewMessage wraps MessageParams in a Message. This is the Go analogue of the
// TypeScript createMessage factory.
func NewMessage(p MessageParams) Message {
	if p.Headers == nil {
		p.Headers = MessageHeaders{}
	}
	return &baseMessage{params: p}
}

func (m *baseMessage) ID() string                 { return m.params.ID }
func (m *baseMessage) Body() []byte               { return m.params.Body }
func (m *baseMessage) Key() string                { return m.params.Key }
func (m *baseMessage) Headers() MessageHeaders    { return m.params.Headers }
func (m *baseMessage) Timestamp() time.Time       { return m.params.Timestamp }
func (m *baseMessage) DeliveryAttempt() int       { return m.params.DeliveryAttempt }
func (m *baseMessage) Metadata() ProviderMetadata { return m.params.Metadata }
func (m *baseMessage) Raw() any                   { return m.params.Raw }

func (m *baseMessage) Ack(ctx context.Context) error {
	if m.params.OnAck == nil {
		return nil
	}
	return m.params.OnAck(ctx)
}

func (m *baseMessage) Nack(ctx context.Context, requeue bool) error {
	if m.params.OnNack == nil {
		return nil
	}
	return m.params.OnNack(ctx, requeue)
}

func (m *baseMessage) ExtendDeadline(ctx context.Context, d time.Duration) error {
	if m.params.OnExtendDeadline == nil {
		return ErrNotSupported
	}
	return m.params.OnExtendDeadline(ctx, d)
}
