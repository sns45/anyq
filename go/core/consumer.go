package core

import (
	"context"
	"time"
)

// Handler processes a single message. Returning an error triggers the consumer's
// configured Strategy (or the adapter's legacy behaviour when no strategy is set).
type Handler func(ctx context.Context, msg Message) error

// BatchHandler processes a batch of messages.
type BatchHandler func(ctx context.Context, msgs []Message) error

// SubscribeOptions configure a subscription.
type SubscribeOptions struct {
	// FromBeginning starts consuming from the beginning (Kafka, NATS).
	FromBeginning bool
	// FromTimestamp starts from a specific time (Kafka, Pub/Sub, NATS).
	FromTimestamp *time.Time
	// Concurrency is the max concurrent message processing. Default: 1.
	Concurrency int
	// AutoAck auto-acknowledges after a handler returns nil. Default: true.
	AutoAck *bool
	// BatchSize is the max messages per batch (batch handlers). Default: 10.
	BatchSize int
	// BatchTimeout is the max wait to fill a batch. Default: 1s.
	BatchTimeout time.Duration
}

// AutoAckEnabled reports the resolved AutoAck value (defaulting to true).
func (o *SubscribeOptions) AutoAckEnabled() bool {
	if o == nil || o.AutoAck == nil {
		return true
	}
	return *o.AutoAck
}

// SeekPosition repositions a consumer (Kafka, NATS).
type SeekPosition struct {
	Beginning bool
	End       bool
	Timestamp *time.Time
	Offset    string
	Partition *int
}

// PartitionLag describes lag for one partition.
type PartitionLag struct {
	Partition     int
	CurrentOffset string
	HighWatermark string
	Lag           int64
}

// ConsumerLag describes total and per-partition lag.
type ConsumerLag struct {
	TotalLag   int64
	Partitions []PartitionLag
}

// Consumer receives messages from a broker.
type Consumer interface {
	Connect(ctx context.Context) error
	Disconnect(ctx context.Context) error
	IsConnected() bool

	// Subscribe consumes messages with a per-message handler. It blocks until
	// ctx is cancelled or a fatal error occurs.
	Subscribe(ctx context.Context, handler Handler, opts *SubscribeOptions) error
	// SubscribeBatch consumes messages with a batch handler.
	SubscribeBatch(ctx context.Context, handler BatchHandler, opts *SubscribeOptions) error

	Pause(ctx context.Context) error
	Resume(ctx context.Context) error
	IsPaused() bool

	HealthCheck(ctx context.Context) (HealthStatus, error)
}

// Seeker is implemented by consumers that support repositioning.
type Seeker interface {
	Seek(ctx context.Context, pos SeekPosition) error
}

// Lagger is implemented by consumers that report lag (Kafka).
type Lagger interface {
	GetLag(ctx context.Context) (ConsumerLag, error)
}
