// Package pgmq implements the anyq interfaces using Postgres and pgmq.
package pgmq

import (
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sns45/anyq/go/core"
)

// Config configures a pgmq producer or consumer.
type Config struct {
	core.BaseQueueConfig
	// ConnectionString is a Postgres URL or keyword connection string.
	// When empty, pgx uses the standard PG environment variables.
	ConnectionString string
	// Pool overrides ConnectionString. The adapter never closes a supplied pool.
	Pool      *pgxpool.Pool
	QueueName string
	// VisibilityTimeout is the processing lease. Default: 30 seconds.
	VisibilityTimeout time.Duration
	// PollInterval is the sleep after an empty read or a transport error.
	// Default: one second.
	PollInterval time.Duration
	// BatchSize is the default size for SubscribeBatch. Default: 100.
	BatchSize int
	// DeadLetterQueue defaults to QueueName followed by _dlq.
	// Set an explicit shorter name when the default would exceed 47 characters.
	DeadLetterQueue string
	// AutoCreate creates the queue and DLQ on connect. Nil means true.
	AutoCreate *bool
	// AutoInstall installs pgmq when its schema is absent. Nil means true.
	AutoInstall *bool
}

var queueNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]{1,47}$`)

func (cfg Config) resolve() (Config, error) {
	cfg.Driver = core.DriverPgmq
	if cfg.DeadLetterQueue == "" {
		if dlq := cfg.BaseQueueConfig.DeadLetterQueue; dlq != nil && dlq.Destination != "" {
			cfg.DeadLetterQueue = dlq.Destination
		} else {
			cfg.DeadLetterQueue = cfg.QueueName + "_dlq"
		}
	}
	for field, value := range map[string]string{"QueueName": cfg.QueueName, "DeadLetterQueue": cfg.DeadLetterQueue} {
		if !queueNamePattern.MatchString(value) {
			return cfg, core.NewConfigurationError(field+" must match ^[a-zA-Z0-9_]{1,47}$", map[string]any{"field": field})
		}
	}
	if strings.EqualFold(cfg.QueueName, cfg.DeadLetterQueue) {
		return cfg, core.NewConfigurationError("DeadLetterQueue must differ from QueueName", nil)
	}
	if cfg.VisibilityTimeout < 0 || cfg.PollInterval < 0 || cfg.BatchSize < 0 || cfg.BatchSize > math.MaxInt32 || cfg.ConnectionTimeout < 0 || cfg.RequestTimeout < 0 {
		return cfg, core.NewConfigurationError("timeouts and batch size must be nonnegative and batch size must fit a Postgres integer", nil)
	}
	if cfg.VisibilityTimeout == 0 {
		cfg.VisibilityTimeout = 30 * time.Second
	}
	if _, err := seconds(cfg.VisibilityTimeout); err != nil {
		return cfg, err
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = time.Second
	}
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 100
	}
	if cfg.ConnectionTimeout == 0 {
		cfg.ConnectionTimeout = core.DefaultConnectionTimeout
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = core.DefaultRequestTimeout
	}
	return cfg, nil
}

func enabled(value *bool) bool { return value == nil || *value }

// seconds rounds up because pgmq accepts only integral seconds.
func seconds(d time.Duration) (int32, error) {
	if d < 0 || d > time.Duration(math.MaxInt32)*time.Second {
		return 0, core.NewConfigurationError("duration must fit a nonnegative Postgres integer number of seconds", nil)
	}
	n := d / time.Second
	if d%time.Second != 0 {
		n++
	}
	return int32(n), nil
}
