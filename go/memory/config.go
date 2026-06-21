package memory

import (
	"time"

	"github.com/sns45/anyq/go/core"
)

// Config configures the memory adapter.
type Config struct {
	core.BaseQueueConfig

	// QueueName is the queue to publish to / consume from. Default: "default".
	QueueName string
	// MaxMessages caps stored messages (0 = unlimited).
	MaxMessages int
	// MaxAgeMs caps message age in milliseconds (0 = unlimited).
	MaxAgeMs int64
}

func (c Config) queueName() string {
	if c.QueueName == "" {
		return "default"
	}
	return c.QueueName
}

func durationMs(ms int64) time.Duration {
	if ms <= 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}
