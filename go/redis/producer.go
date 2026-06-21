package redis

import (
	"context"
	"encoding/json"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to a Redis Stream using XADD. It mirrors the
// TypeScript RedisStreamsProducer.
type Producer struct {
	core.BaseProducer

	cfg        Config
	streamName string
	maxLen     int64
	approx     bool

	client *goredis.Client
}

// NewProducer builds a Redis Streams producer.
func NewProducer(cfg Config) *Producer {
	cfg = cfg.withDefaults()
	p := &Producer{
		cfg:        cfg,
		streamName: cfg.Redis.KeyPrefix + cfg.StreamName,
		maxLen:     cfg.MaxStreamLength,
		approx:     cfg.ApproximateTrimming,
	}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect dials Redis and verifies connectivity.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	client, err := newClient(p.cfg.Redis)
	if err != nil {
		return core.NewConnectionError("failed to connect to Redis", err)
	}
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return core.NewConnectionError("failed to connect to Redis", err)
	}
	p.client = client
	p.SetConnected(true)
	p.Logger.Info("Redis Streams producer connected", map[string]any{"stream": p.streamName})
	return nil
}

// Disconnect closes the Redis connection.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() || p.client == nil {
		return nil
	}
	_ = p.client.Close()
	p.client = nil
	p.SetConnected(false)
	p.Logger.Info("Redis Streams producer disconnected", nil)
	return nil
}

// fields builds the XADD field map for a message body + options.
func fields(body []byte, opts *core.PublishOptions) map[string]interface{} {
	m := map[string]interface{}{"body": string(body)}
	if opts != nil {
		if opts.Key != "" {
			m["key"] = opts.Key
		}
		if len(opts.Headers) > 0 {
			// Mirror TS JSON.stringify(headers). MessageHeaders values are bytes.
			enc := make(map[string]string, len(opts.Headers))
			for k, v := range opts.Headers {
				enc[k] = string(v)
			}
			if raw, err := json.Marshal(enc); err == nil {
				m["headers"] = string(raw)
			}
		}
	}
	return m
}

func (p *Producer) xaddArgs(body []byte, opts *core.PublishOptions) *goredis.XAddArgs {
	return &goredis.XAddArgs{
		Stream: p.streamName,
		MaxLen: p.maxLen, // 0 => no trimming
		Approx: p.approx,
		ID:     "*",
		Values: fields(body, opts),
	}
}

// Publish appends a single message to the stream and returns its entry id.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.client == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}
	id, err := p.client.XAdd(ctx, p.xaddArgs(body, opts)).Result()
	if err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	p.Logger.Debug("message published", map[string]any{"messageId": id, "stream": p.streamName})
	return id, nil
}

// PublishBatch appends several messages via a pipeline, returning ids in order.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.client == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}
	pipe := p.client.Pipeline()
	cmds := make([]*goredis.StringCmd, 0, len(items))
	for _, item := range items {
		cmds = append(cmds, pipe.XAdd(ctx, p.xaddArgs(item.Body, item.Options)))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, core.NewPublishError("failed to publish batch", true, err)
	}
	ids := make([]string, 0, len(cmds))
	for _, c := range cmds {
		id, err := c.Result()
		if err != nil {
			return nil, core.NewPublishError("failed to publish batch", true, err)
		}
		ids = append(ids, id)
	}
	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "stream": p.streamName})
	return ids, nil
}

// Flush is a no-op; XADD writes synchronously.
func (p *Producer) Flush(ctx context.Context) error { return nil }

// HealthCheck pings Redis and reports stream length.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if p.client == nil || !p.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	if err := p.client.Ping(ctx).Err(); err != nil {
		return core.HealthStatus{
			Healthy:   false,
			Connected: false,
			LatencyMs: time.Since(start).Milliseconds(),
			Error:     err.Error(),
		}, nil
	}
	var length int64
	if info, err := p.client.XInfoStream(ctx, p.streamName).Result(); err == nil && info != nil {
		length = info.Length
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"stream": p.streamName, "length": length},
	}, nil
}

// Client returns the underlying Redis client (for testing).
func (p *Producer) Client() *goredis.Client { return p.client }

var _ core.Producer = (*Producer)(nil)
