package core

import (
	"context"
	"time"
)

// PublishOptions are per-message publishing options. Fields not relevant to a
// given broker are ignored by that adapter.
type PublishOptions struct {
	Key             string
	Headers         MessageHeaders
	Partition       *int          // Kafka
	Delay           time.Duration // SQS, Azure, Google Pub/Sub
	GroupID         string        // SQS FIFO, Azure sessions
	DeduplicationID string        // SQS FIFO
	OrderingKey     string        // Google Pub/Sub
	Priority        *uint8        // RabbitMQ
	TTL             time.Duration // message TTL
	CorrelationID   string
	ReplyTo         string
}

// BatchItem is one entry in a PublishBatch call.
type BatchItem struct {
	Body    []byte
	Options *PublishOptions
}

// HealthStatus is returned by HealthCheck.
type HealthStatus struct {
	Healthy   bool
	Connected bool
	LatencyMs int64
	Details   map[string]any
	Error     string
}

// Producer publishes messages to a broker.
type Producer interface {
	Connect(ctx context.Context) error
	Disconnect(ctx context.Context) error
	IsConnected() bool

	// Publish sends a single message and returns its broker id/sequence.
	Publish(ctx context.Context, body []byte, opts *PublishOptions) (string, error)
	// PublishBatch sends multiple messages and returns ids in the same order.
	PublishBatch(ctx context.Context, items []BatchItem) ([]string, error)
	// Flush flushes any buffered messages (no-op for non-batching producers).
	Flush(ctx context.Context) error
	HealthCheck(ctx context.Context) (HealthStatus, error)
}
