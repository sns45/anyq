// Package sqs implements the anyq Producer/Consumer interfaces for AWS SQS,
// mirroring the TypeScript @anyq/sqs adapter. It supports native delayed
// redelivery (Park) via SendMessage DelaySeconds and relies on SQS redrive
// policies / visibility timeout for dead-lettering.
package sqs

import "github.com/sns45/anyq/go/core"

// ConnectionConfig holds AWS connection settings (mirrors SQSConnectionConfig).
type ConnectionConfig struct {
	// Region is the AWS region. Default: "us-east-1".
	Region string
	// Endpoint is a custom endpoint URL (e.g. LocalStack). Optional.
	Endpoint string
	// AccessKeyID is the AWS access key id. Optional (falls back to the default
	// credential chain when empty).
	AccessKeyID string
	// SecretAccessKey is the AWS secret access key. Optional.
	SecretAccessKey string
}

// ProducerOptions holds producer-side options (mirrors SQSProducerOptions).
type ProducerOptions struct {
	// DelaySeconds delays delivery for every published message (0-900).
	DelaySeconds int32
	// MessageGroupID is the default FIFO message group id.
	MessageGroupID string
	// MessageDeduplicationID is the default FIFO deduplication id.
	MessageDeduplicationID string
}

// ConsumerOptions holds consumer-side options (mirrors SQSConsumerOptions).
type ConsumerOptions struct {
	// MaxNumberOfMessages is the max messages per ReceiveMessage (1-10). Default: 10.
	MaxNumberOfMessages int32
	// WaitTimeSeconds is the long-poll wait time (0-20). Default: 20.
	WaitTimeSeconds int32
	// VisibilityTimeout is the visibility timeout in seconds. Default: 30.
	VisibilityTimeout int32
	// PollingInterval is the poll interval in ms when the queue is empty. Default: 1000.
	PollingInterval int
}

// Config configures the SQS adapter. It embeds core.BaseQueueConfig.
type Config struct {
	core.BaseQueueConfig

	// SQS holds the AWS connection configuration.
	SQS ConnectionConfig

	// QueueURL is the queue URL (or name) to publish to / consume from.
	QueueURL string

	// FIFO marks the queue as a FIFO queue.
	FIFO bool

	// Producer holds producer options.
	Producer ProducerOptions

	// Consumer holds consumer options.
	Consumer ConsumerOptions

	// DeadLetterQueueURL is an optional DLQ URL (informational; SQS routes via
	// the queue's redrive policy).
	DeadLetterQueueURL string
}

// region returns the configured region, defaulting to us-east-1.
func (c Config) region() string {
	if c.SQS.Region == "" {
		return "us-east-1"
	}
	return c.SQS.Region
}

// maxNumberOfMessages returns the receive batch size, defaulting to 10.
func (c Config) maxNumberOfMessages() int32 {
	if c.Consumer.MaxNumberOfMessages > 0 {
		return c.Consumer.MaxNumberOfMessages
	}
	return 10
}

// waitTimeSeconds returns the long-poll wait time, defaulting to 20.
func (c Config) waitTimeSeconds() int32 {
	if c.Consumer.WaitTimeSeconds > 0 {
		return c.Consumer.WaitTimeSeconds
	}
	return 20
}

// visibilityTimeout returns the visibility timeout, defaulting to 30.
func (c Config) visibilityTimeout() int32 {
	if c.Consumer.VisibilityTimeout > 0 {
		return c.Consumer.VisibilityTimeout
	}
	return 30
}

// pollingIntervalMs returns the empty-queue poll interval in ms, defaulting to 1000.
func (c Config) pollingIntervalMs() int {
	if c.Consumer.PollingInterval > 0 {
		return c.Consumer.PollingInterval
	}
	return 1000
}
