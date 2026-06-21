// Package sns implements the anyq producer adapter for AWS SNS.
//
// SNS is publish-only (fan-out): there is no consumer. To consume messages,
// subscribe an SQS queue (or other endpoint) to the topic. This package mirrors
// the TypeScript @anyq/sns adapter.
package sns

import "github.com/sns45/anyq/go/core"

// ConnectionConfig holds AWS connection settings for SNS. Credentials are
// optional; when omitted the default AWS credential chain is used.
type ConnectionConfig struct {
	// Region is the AWS region (e.g. "us-east-1").
	Region string
	// Endpoint optionally overrides the service endpoint (e.g. for LocalStack).
	Endpoint string
	// AccessKeyID is an optional static access key id.
	AccessKeyID string
	// SecretAccessKey is an optional static secret access key.
	SecretAccessKey string
}

// ProducerOptions holds per-producer publish defaults.
type ProducerOptions struct {
	// MessageGroupID is the default message group id for FIFO topics.
	MessageGroupID string
	// MessageDeduplicationID is the default deduplication id for FIFO topics.
	// When empty, a unique id is generated per publish.
	MessageDeduplicationID string
	// Subject is an optional subject (used by email-type subscriptions).
	Subject string
}

// Config configures the SNS producer. It embeds core.BaseQueueConfig.
type Config struct {
	core.BaseQueueConfig

	// SNS holds the connection configuration.
	SNS ConnectionConfig

	// TopicArn is the ARN of the topic to publish to.
	TopicArn string

	// FIFO indicates the topic is a FIFO topic.
	FIFO bool

	// Producer holds publish-time defaults.
	Producer ProducerOptions
}
