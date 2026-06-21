// Package nats implements the anyq adapter for NATS JetStream.
//
// It mirrors the TypeScript @anyq/nats package: persistent messaging on top of
// JetStream with native delayed redelivery (NakWithDelay) used for the Park
// retry decision.
package nats

import (
	"time"

	"github.com/sns45/anyq/go/core"
)

// ConnectionConfig configures the NATS client connection. Mirrors the TS
// NATSConnectionConfig.
type ConnectionConfig struct {
	// Servers is one or more NATS server URLs (e.g. "nats://localhost:4222").
	Servers []string
	// Name identifies the connection.
	Name string
	// User / Pass for username/password authentication.
	User string
	Pass string
	// Token for token authentication.
	Token string
	// MaxReconnectAttempts caps reconnect attempts. Default: 10.
	MaxReconnectAttempts int
	// ReconnectWait is the wait between reconnects. Default: 2s.
	ReconnectWait time.Duration
	// Timeout is the connection timeout. Default: 10s.
	Timeout time.Duration
	// PingInterval is the keepalive ping interval. Default: 60s.
	PingInterval time.Duration
}

// JetStreamConfig configures the JetStream stream. Mirrors the TS
// JetStreamConfig.
type JetStreamConfig struct {
	// Stream is the stream name.
	Stream string
	// Subjects the stream binds to. Defaults to [Subject] when empty.
	Subjects []string
	// Storage is "file" or "memory". Default: "memory".
	Storage string
	// Replicas is the number of stream replicas. Default: 1.
	Replicas int
	// Retention is "limits", "interest" or "workqueue". Default: "limits".
	Retention string
	// MaxMsgs caps messages in the stream (0 / negative = unlimited).
	MaxMsgs int64
	// MaxBytes caps stream size in bytes (0 / negative = unlimited).
	MaxBytes int64
	// MaxAge caps message age. 0 = unlimited.
	MaxAge time.Duration
	// Discard is "old" or "new" when limits are reached. Default: "old".
	Discard string
	// DuplicateWindow is the dedup window. Default: 2m.
	DuplicateWindow time.Duration
}

// ConsumerOptions configures the JetStream durable consumer. Mirrors the TS
// JetStreamConsumerOptions.
type ConsumerOptions struct {
	// DurableName is the durable consumer name. When empty a unique ephemeral
	// name is generated per Subscribe call.
	DurableName string
	// Description is an optional consumer description.
	Description string
	// DeliverPolicy is "all", "last", "new", "byStartSequence", "byStartTime"
	// or "lastPerSubject". Default: "all".
	DeliverPolicy string
	// OptStartSeq is the start sequence for the byStartSequence policy.
	OptStartSeq uint64
	// OptStartTime is the start time for the byStartTime policy.
	OptStartTime *time.Time
	// AckWait is the ack timeout. Default: 30s.
	AckWait time.Duration
	// MaxDeliver caps delivery attempts. Default: 5.
	MaxDeliver int
	// FilterSubject filters the subjects delivered to the consumer. Defaults to
	// [Subject] when empty.
	FilterSubject string
	// MaxAckPending caps in-flight unacknowledged messages. Default: 1000.
	MaxAckPending int
	// ReplayPolicy is "instant" or "original". Default: "instant".
	ReplayPolicy string
	// Batch is the consume buffer size (max in-flight pull). Default: 10.
	Batch int
	// Expires is the pull request expiry. Default: 5s.
	Expires time.Duration
}

// Config configures the NATS adapter (producer and consumer share it).
type Config struct {
	core.BaseQueueConfig

	// Connection configures the NATS client connection.
	Connection ConnectionConfig
	// JetStream configures the stream.
	JetStream JetStreamConfig
	// Subject is the subject to publish to / subscribe from.
	Subject string
	// Consumer configures the durable consumer (consumer only).
	Consumer ConsumerOptions
	// MsgIDHeader is the dedup header name. Default: "Nats-Msg-Id".
	MsgIDHeader string
	// ExpectedStream, when set, validates publishes target this stream.
	ExpectedStream string
	// DeadLetterSubject, when set, is recorded for observability; redelivery /
	// dead-lettering is governed by MaxDeliver and the broker (matches TS).
	DeadLetterSubject string
}

// Defaults mirror NATS_DEFAULTS from the TypeScript config.
const (
	defaultServer          = "nats://localhost:4222"
	defaultMaxReconnect    = 10
	defaultReconnectWait   = 2 * time.Second
	defaultTimeout         = 10 * time.Second
	defaultPingInterval    = 60 * time.Second
	defaultReplicas        = 1
	defaultDuplicateWindow = 2 * time.Minute
	defaultAckWait         = 30 * time.Second
	defaultMaxDeliver      = 5
	defaultMaxAckPending   = 1000
	defaultBatch           = 10
	defaultExpires         = 5 * time.Second
	defaultMsgIDHeader     = "Nats-Msg-Id"
)

// withDefaults returns a copy of cfg with zero-value fields filled from the
// defaults, mirroring the TS constructor merge behaviour.
func (c Config) withDefaults() Config {
	out := c
	if out.Driver == "" {
		out.Driver = core.DriverNATS
	}

	conn := out.Connection
	if len(conn.Servers) == 0 {
		conn.Servers = []string{defaultServer}
	}
	if conn.MaxReconnectAttempts == 0 {
		conn.MaxReconnectAttempts = defaultMaxReconnect
	}
	if conn.ReconnectWait == 0 {
		conn.ReconnectWait = defaultReconnectWait
	}
	if conn.Timeout == 0 {
		conn.Timeout = defaultTimeout
	}
	if conn.PingInterval == 0 {
		conn.PingInterval = defaultPingInterval
	}
	out.Connection = conn

	js := out.JetStream
	if js.Storage == "" {
		js.Storage = "memory"
	}
	if js.Replicas == 0 {
		js.Replicas = defaultReplicas
	}
	if js.Retention == "" {
		js.Retention = "limits"
	}
	if js.Discard == "" {
		js.Discard = "old"
	}
	if js.DuplicateWindow == 0 {
		js.DuplicateWindow = defaultDuplicateWindow
	}
	out.JetStream = js

	cons := out.Consumer
	if cons.DeliverPolicy == "" {
		cons.DeliverPolicy = "all"
	}
	if cons.AckWait == 0 {
		cons.AckWait = defaultAckWait
	}
	if cons.MaxDeliver == 0 {
		cons.MaxDeliver = defaultMaxDeliver
	}
	if cons.MaxAckPending == 0 {
		cons.MaxAckPending = defaultMaxAckPending
	}
	if cons.ReplayPolicy == "" {
		cons.ReplayPolicy = "instant"
	}
	if cons.Batch == 0 {
		cons.Batch = defaultBatch
	}
	if cons.Expires == 0 {
		cons.Expires = defaultExpires
	}
	out.Consumer = cons

	if out.MsgIDHeader == "" {
		out.MsgIDHeader = defaultMsgIDHeader
	}
	return out
}

// subjects returns the stream subjects, defaulting to the publish subject.
func (c Config) subjects() []string {
	if len(c.JetStream.Subjects) > 0 {
		return c.JetStream.Subjects
	}
	return []string{c.Subject}
}
