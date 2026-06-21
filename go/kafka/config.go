// Package kafka implements the anyq Producer and Consumer interfaces on top of
// Apache Kafka, using github.com/segmentio/kafka-go (Reader for consumer groups,
// Writer for producing).
//
// This adapter mirrors the shipped TypeScript adapter (@anyq/kafka, 0.3.0):
//   - SupportsNativeDelay() is false, so a Park decision downgrades to an
//     in-process retry handled by core.BaseConsumer.ApplyStrategy.
//   - DeadLetterMessage is NOT overridden, so it uses the base default
//     (warn + nack(false)). The TS adapter notes a "<topic>.dlq" pattern as a
//     follow-up that is not implemented in 0.3.0.
//   - Batch handling is offset-based and therefore all-or-nothing: the retry
//     strategy applies to the batch as a single unit.
package kafka

import (
	"github.com/sns45/anyq/go/core"
)

// SASLMechanism enumerates supported SASL mechanisms (mirrors the TS config).
type SASLMechanism string

const (
	SASLPlain       SASLMechanism = "plain"
	SASLScramSHA256 SASLMechanism = "scram-sha-256"
	SASLScramSHA512 SASLMechanism = "scram-sha-512"
)

// SASLConfig configures SASL authentication. Mirrors KafkaSASLConfig in TS.
type SASLConfig struct {
	Mechanism SASLMechanism
	Username  string
	Password  string
}

// SSLConfig configures TLS. Mirrors KafkaSSLConfig in TS.
type SSLConfig struct {
	// Enabled turns on TLS for broker connections.
	Enabled bool
	// InsecureSkipVerify disables certificate verification (the inverse of the
	// TS rejectUnauthorized flag). Default false (verify certs).
	InsecureSkipVerify bool
	// CA is an optional CA certificate (PEM).
	CA []byte
	// Cert and Key are an optional client certificate/key pair (PEM).
	Cert []byte
	Key  []byte
}

// ProducerOptions configures the Writer. Mirrors KafkaProducerOptions in TS.
type ProducerOptions struct {
	// Acks is the acknowledgment level: 0 (none), 1 (leader), -1 (all).
	// Default: -1 (all).
	Acks int
	// Compression: "none", "gzip", "snappy", "lz4", "zstd". Default: none.
	Compression string
	// BatchSize is the max messages buffered per partition before a write.
	BatchSize int
	// BatchTimeoutMs flushes incomplete batches at least this often.
	BatchTimeoutMs int
}

// ConsumerGroupOptions configures the Reader/consumer group. Mirrors
// KafkaConsumerGroupConfig in TS.
type ConsumerGroupOptions struct {
	// GroupID is the consumer group id. Required for group consumption.
	GroupID string
	// SessionTimeoutMs is the consumer-group session timeout. Default: 30000.
	SessionTimeoutMs int
	// HeartbeatIntervalMs is the heartbeat interval. Default: 3000.
	HeartbeatIntervalMs int
	// MinBytes is the minimum fetch size. Default: 1.
	MinBytes int
	// MaxBytes is the maximum fetch size. Default: 10485760 (10MB).
	MaxBytes int
	// MaxWaitMs is the max time to wait when fetching. Default: 5000.
	MaxWaitMs int
	// FromBeginning starts a fresh group at the earliest offset. Default: false.
	FromBeginning bool
}

// Config configures the Kafka adapter. It embeds core.BaseQueueConfig (shared
// retry/circuit-breaker/strategy/logging) and adds Kafka-specific fields,
// mirroring the TypeScript KafkaConfig.
type Config struct {
	core.BaseQueueConfig

	// Brokers is the list of broker addresses (host:port).
	Brokers []string
	// Topic is the topic to produce to / consume from.
	Topic string
	// ClientID identifies the client (also feeds BaseQueueConfig.ClientID).
	ClientID string

	// SASL configures optional SASL authentication.
	SASL *SASLConfig
	// SSL configures optional TLS.
	SSL *SSLConfig

	// Producer configures the Writer.
	Producer *ProducerOptions
	// ConsumerGroup configures the Reader/consumer group.
	ConsumerGroup *ConsumerGroupOptions

	// NumPartitions is used when ensuring the topic exists. Default: 1.
	NumPartitions int
	// ReplicationFactor is used when ensuring the topic exists. Default: 1.
	ReplicationFactor int
}

// applyDefaults fills in zero-valued fields with the adapter defaults, matching
// DEFAULT_KAFKA_CONFIG in the TypeScript adapter.
func (c *Config) applyDefaults() {
	if c.Driver == "" {
		c.Driver = core.DriverKafka
	}
	if len(c.Brokers) == 0 {
		c.Brokers = []string{"localhost:9092"}
	}
	if c.ClientID == "" {
		c.ClientID = "anyq-client"
	}
	// Mirror ClientID into the embedded config so the logger is prefixed.
	if c.BaseQueueConfig.ClientID == "" {
		c.BaseQueueConfig.ClientID = c.ClientID
	}
	if c.NumPartitions <= 0 {
		c.NumPartitions = 1
	}
	if c.ReplicationFactor <= 0 {
		c.ReplicationFactor = 1
	}
}
