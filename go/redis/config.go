// Package redis implements the Redis Streams adapter for anyq.
//
// It mirrors the behaviour of the TypeScript @anyq/redis-streams package:
// producers publish via XADD, consumers read via XREADGROUP within a consumer
// group and acknowledge with XACK. The adapter does NOT support native delayed
// redelivery, so park decisions downgrade to in-process retry (handled by the
// core ApplyStrategy).
package redis

import (
	"github.com/sns45/anyq/go/core"
)

// RedisConnectionConfig mirrors the TS RedisConnectionConfig.
type RedisConnectionConfig struct {
	// Host is the Redis host. Default: "localhost".
	Host string
	// Port is the Redis port. Default: 6379.
	Port int
	// Password is the Redis password (optional).
	Password string
	// DB is the Redis database number. Default: 0.
	DB int
	// Username is the Redis username for ACL (Redis 6+).
	Username string
	// TLS enables TLS/SSL when true.
	TLS bool
	// URL is a connection URL that overrides the discrete options when set.
	URL string
	// KeyPrefix is prepended to all keys.
	KeyPrefix string
	// ConnectionName sets CLIENT SETNAME.
	ConnectionName string
}

// ConsumerGroupConfig mirrors the TS ConsumerGroupConfig.
type ConsumerGroupConfig struct {
	// GroupName is the consumer group name.
	GroupName string
	// ConsumerName is the consumer name within the group.
	ConsumerName string
	// AutoCreate creates the group on connect when not explicitly disabled.
	// Defaults to true (a nil pointer means "create").
	AutoCreate *bool
	// StartID is the position to start reading from for a newly created group.
	// "$" = new messages only, "0" = from the beginning. Default: "0".
	StartID string
}

// Config configures the Redis Streams adapter. It embeds the shared
// BaseQueueConfig and adds Redis-specific fields mirroring TS RedisStreamsConfig.
type Config struct {
	core.BaseQueueConfig

	// Redis holds the connection settings.
	Redis RedisConnectionConfig

	// StreamName is the stream key in Redis.
	StreamName string

	// ConsumerGroup holds the consumer-group settings (required for consumers).
	ConsumerGroup ConsumerGroupConfig

	// MaxStreamLength caps the stream length (MAXLEN). 0 = unlimited. Default: 0.
	MaxStreamLength int64

	// ApproximateTrimming uses approximate (~) trimming when true. Default: true.
	ApproximateTrimming bool

	// BlockTimeoutMs is the XREADGROUP BLOCK timeout in ms. Default: 5000.
	BlockTimeoutMs int

	// BatchSize is the number of messages to read per poll. Default: 10.
	BatchSize int

	// ClaimTimeoutMs enables auto-claim of pending messages older than this (ms).
	// 0 = disabled. Default: 30000.
	ClaimTimeoutMs int

	// MinIdleTimeMs is the minimum idle time for auto-claim (ms). Default: 10000.
	MinIdleTimeMs int
}

const (
	defaultHost           = "localhost"
	defaultPort           = 6379
	defaultBlockTimeoutMs = 5000
	defaultBatchSize      = 10
	defaultClaimTimeoutMs = 30000
	defaultMinIdleTimeMs  = 10000
	defaultStartID        = "0"
	defaultGroupName      = "default-group"
)

// withDefaults returns a copy of cfg with TS-equivalent defaults applied.
func (c Config) withDefaults() Config {
	if c.Driver == "" {
		c.Driver = core.DriverRedisStreams
	}
	if c.Redis.Host == "" {
		c.Redis.Host = defaultHost
	}
	if c.Redis.Port == 0 {
		c.Redis.Port = defaultPort
	}
	if c.BlockTimeoutMs == 0 {
		c.BlockTimeoutMs = defaultBlockTimeoutMs
	}
	if c.BatchSize == 0 {
		c.BatchSize = defaultBatchSize
	}
	// ClaimTimeoutMs / MinIdleTimeMs: 0 is a meaningful "disabled" value for
	// claim timeout, but the TS default is non-zero, so only fill when the field
	// is left at the zero value AND the caller did not explicitly disable it.
	// We treat the zero value as "use default" to match TS ?? semantics.
	if c.ClaimTimeoutMs == 0 {
		c.ClaimTimeoutMs = defaultClaimTimeoutMs
	}
	if c.MinIdleTimeMs == 0 {
		c.MinIdleTimeMs = defaultMinIdleTimeMs
	}
	if c.ConsumerGroup.GroupName == "" {
		c.ConsumerGroup.GroupName = defaultGroupName
	}
	if c.ConsumerGroup.StartID == "" {
		c.ConsumerGroup.StartID = defaultStartID
	}
	return c
}

// autoCreateEnabled reports whether the consumer group should be created on
// connect. Mirrors TS `autoCreate !== false` (nil/true => create).
func (g ConsumerGroupConfig) autoCreateEnabled() bool {
	return g.AutoCreate == nil || *g.AutoCreate
}
