package redis

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/sns45/anyq/go/core"
)

// Consumer reads messages from a Redis Stream via a consumer group (XREADGROUP)
// and acknowledges with XACK. It mirrors the TypeScript RedisStreamsConsumer.
//
// Capability note: Redis Streams has no native delayed-redelivery primitive, so
// SupportsNativeDelay is left false (the base default). Park decisions therefore
// downgrade to in-process retry inside core.ApplyStrategy.
type Consumer struct {
	*core.BaseConsumer

	cfg          Config
	streamName   string
	groupName    string
	consumerName string
	blockTimeout time.Duration
	claimTimeout time.Duration
	minIdleTime  time.Duration

	client *goredis.Client
}

// NewConsumer builds a Redis Streams consumer. Like the memory reference, it
// embeds *core.BaseConsumer, calls InitBase then Bind(self) so ApplyStrategy
// dispatches to this adapter's hook overrides.
func NewConsumer(cfg Config) *Consumer {
	cfg = cfg.withDefaults()
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)

	consumerName := cfg.ConsumerGroup.ConsumerName
	if consumerName == "" {
		consumerName = "consumer-" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	}

	c := &Consumer{
		BaseConsumer: bc,
		cfg:          cfg,
		streamName:   cfg.Redis.KeyPrefix + cfg.StreamName,
		groupName:    cfg.ConsumerGroup.GroupName,
		consumerName: consumerName,
		blockTimeout: time.Duration(cfg.BlockTimeoutMs) * time.Millisecond,
		claimTimeout: time.Duration(cfg.ClaimTimeoutMs) * time.Millisecond,
		minIdleTime:  time.Duration(cfg.MinIdleTimeMs) * time.Millisecond,
	}
	bc.Bind(c)
	return c
}

// Connect dials Redis and creates the consumer group (XGROUP CREATE MKSTREAM).
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	client, err := newClient(c.cfg.Redis)
	if err != nil {
		return core.NewConnectionError("failed to connect to Redis", err)
	}
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return core.NewConnectionError("failed to connect to Redis", err)
	}
	c.client = client

	if c.cfg.ConsumerGroup.autoCreateEnabled() {
		if err := c.ensureConsumerGroup(ctx); err != nil {
			_ = client.Close()
			c.client = nil
			return core.NewConnectionError("failed to connect to Redis", err)
		}
	}

	c.SetConnected(true)
	c.Logger.Info("Redis Streams consumer connected", map[string]any{
		"stream": c.streamName, "group": c.groupName, "consumer": c.consumerName,
	})
	return nil
}

// ensureConsumerGroup creates the group, ignoring BUSYGROUP (already exists).
func (c *Consumer) ensureConsumerGroup(ctx context.Context) error {
	startID := c.cfg.ConsumerGroup.StartID
	if startID == "" {
		startID = defaultStartID
	}
	err := c.client.XGroupCreateMkStream(ctx, c.streamName, c.groupName, startID).Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	c.Logger.Debug("consumer group ready", map[string]any{"group": c.groupName, "stream": c.streamName})
	return nil
}

// Disconnect closes the Redis connection.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() || c.client == nil {
		return nil
	}
	_ = c.client.Close()
	c.client = nil
	c.SetConnected(false)
	c.Logger.Info("Redis Streams consumer disconnected", nil)
	return nil
}

// Subscribe consumes messages until ctx is cancelled. On handler success it
// XACKs; on handler error it runs core.ApplyStrategy with a reinvoke closure,
// and on the !handled fallback preserves the TS legacy behaviour (log + emit
// error; leave the entry pending for later reclaim).
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.client == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to stream", map[string]any{"stream": c.streamName, "group": c.groupName})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if err := sleepCtx(ctx, 100*time.Millisecond); err != nil {
				return err
			}
			continue
		}

		// Reclaim idle pending messages first (parity with TS poll loop).
		if c.claimTimeout > 0 {
			if err := c.processPending(ctx, handler, autoAck); err != nil {
				return err
			}
		}

		entries, err := c.readMessages(ctx, 1)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if c.IsPaused() {
				break
			}
			if herr := c.handleOne(ctx, handler, entry, autoAck); herr != nil {
				return herr
			}
		}
	}
}

// handleOne processes a single entry, returning a non-nil error only for fatal
// outcomes (Fail decision / context cancellation) that should stop the loop.
func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, entry goredis.XMessage, autoAck bool) error {
	msg := c.wrap(entry)
	herr := handler(ctx, msg)
	if herr == nil {
		if autoAck {
			return msg.Ack(ctx)
		}
		return nil
	}

	reinvoke := func() error { return handler(ctx, msg) }
	handled, applyErr := c.ApplyStrategy(ctx, msg, herr, reinvoke)
	if applyErr != nil {
		return applyErr
	}
	if handled {
		return nil
	}

	// Legacy behaviour (TS !result.handled branch): log, emit error, and leave
	// the entry pending so it can be reclaimed later. No ack/nack here.
	c.Logger.Error("error processing message", map[string]any{
		"messageId": entry.ID, "error": herr.Error(),
	})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	return nil
}

// processPending reclaims and re-processes idle pending entries via XAUTOCLAIM.
func (c *Consumer) processPending(ctx context.Context, handler core.Handler, autoAck bool) error {
	msgs, _, err := c.client.XAutoClaim(ctx, &goredis.XAutoClaimArgs{
		Stream:   c.streamName,
		Group:    c.groupName,
		Consumer: c.consumerName,
		MinIdle:  c.minIdleTime,
		Start:    "0-0",
		Count:    5,
	}).Result()
	if err != nil {
		// XAUTOCLAIM may be unavailable on older Redis; mirror TS debug-and-skip.
		c.Logger.Debug("XAUTOCLAIM failed; skipping pending processing", map[string]any{"error": err.Error()})
		return nil
	}
	for _, entry := range msgs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			break
		}
		if herr := c.handleOne(ctx, handler, entry, autoAck); herr != nil {
			return herr
		}
	}
	return nil
}

// SubscribeBatch consumes batches; on batch error applies strategy per message
// (Redis Streams supports per-entry ack), matching the TS adapter.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.client == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	batchSize := c.cfg.BatchSize
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to stream (batch)", map[string]any{"stream": c.streamName, "group": c.groupName})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if err := sleepCtx(ctx, 100*time.Millisecond); err != nil {
				return err
			}
			continue
		}

		entries, err := c.readMessages(ctx, int64(batchSize))
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			continue
		}
		msgs := make([]core.Message, len(entries))
		for i, e := range entries {
			msgs[i] = c.wrap(e)
		}

		herr := handler(ctx, msgs)
		if herr == nil {
			if autoAck {
				for _, m := range msgs {
					_ = m.Ack(ctx)
				}
			}
			continue
		}

		anyUnhandled := false
		for _, m := range msgs {
			mm := m
			reinvoke := func() error { return handler(ctx, []core.Message{mm}) }
			handled, applyErr := c.ApplyStrategy(ctx, mm, herr, reinvoke)
			if applyErr != nil {
				return applyErr
			}
			if !handled {
				anyUnhandled = true
			}
		}
		if anyUnhandled {
			c.Logger.Error("error processing batch", map[string]any{"count": len(msgs), "error": herr.Error()})
			if c.Config.OnError != nil {
				c.Config.OnError(herr)
			}
		}
	}
}

// readMessages reads up to count new entries via XREADGROUP with BLOCK.
func (c *Consumer) readMessages(ctx context.Context, count int64) ([]goredis.XMessage, error) {
	streams, err := c.client.XReadGroup(ctx, &goredis.XReadGroupArgs{
		Group:    c.groupName,
		Consumer: c.consumerName,
		Streams:  []string{c.streamName, ">"},
		Count:    count,
		Block:    c.blockTimeout,
	}).Result()
	if err != nil {
		if err == goredis.Nil {
			return nil, nil // BLOCK timeout, no messages
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Transient read error: mirror TS log-and-return-empty so the loop retries.
		c.Logger.Error("error reading messages", map[string]any{"error": err.Error()})
		return nil, nil
	}
	var out []goredis.XMessage
	for _, s := range streams {
		out = append(out, s.Messages...)
	}
	return out, nil
}

// Pause and Resume rely on the embedded BaseConsumer defaults; the Subscribe
// loops check IsPaused().

// HealthCheck pings Redis and reports consumer-group pending count.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if c.client == nil || !c.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	if err := c.client.Ping(ctx).Err(); err != nil {
		return core.HealthStatus{
			Healthy:   false,
			Connected: false,
			LatencyMs: time.Since(start).Milliseconds(),
			Error:     err.Error(),
		}, nil
	}
	var pending int64
	if groups, err := c.client.XInfoGroups(ctx, c.streamName).Result(); err == nil {
		for _, g := range groups {
			if g.Name == c.groupName {
				pending = g.Pending
				break
			}
		}
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details: map[string]any{
			"stream":   c.streamName,
			"group":    c.groupName,
			"consumer": c.consumerName,
			"pending":  pending,
			"paused":   c.IsPaused(),
		},
	}, nil
}

// Client returns the underlying Redis client (for testing).
func (c *Consumer) Client() *goredis.Client { return c.client }

// wrap builds a core.Message from a Redis stream entry. Ack performs XACK; Nack
// performs XACK only when requeue is false (remove from pending), matching TS.
func (c *Consumer) wrap(entry goredis.XMessage) core.Message {
	body := fieldString(entry.Values, "body")
	key := fieldString(entry.Values, "key")

	headers := core.MessageHeaders{}
	if raw := fieldString(entry.Values, "headers"); raw != "" {
		var decoded map[string]string
		if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
			for k, v := range decoded {
				headers[k] = []byte(v)
			}
		}
	}

	return core.NewMessage(core.MessageParams{
		ID:              entry.ID,
		Body:            []byte(body),
		Key:             key,
		Headers:         headers,
		Timestamp:       timestampFromID(entry.ID),
		DeliveryAttempt: 1,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverRedisStreams,
			RedisStreams: &core.RedisStreamsMetadata{
				Stream:        c.streamName,
				EntryID:       entry.ID,
				ConsumerGroup: c.groupName,
				Consumer:      c.consumerName,
			},
		},
		Raw: entry,
		OnAck: func(ctx context.Context) error {
			if c.client == nil {
				return nil
			}
			if err := c.client.XAck(ctx, c.streamName, c.groupName, entry.ID).Err(); err != nil {
				return err
			}
			c.Logger.Debug("message acknowledged", map[string]any{"messageId": entry.ID})
			return nil
		},
		OnNack: func(ctx context.Context, requeue bool) error {
			// No direct nack in Redis Streams. requeue=false => XACK (drop from
			// pending). requeue=true => leave pending for reclaim.
			if !requeue && c.client != nil {
				if err := c.client.XAck(ctx, c.streamName, c.groupName, entry.ID).Err(); err != nil {
					return err
				}
			}
			c.Logger.Debug("message nacked", map[string]any{"messageId": entry.ID, "requeue": requeue})
			return nil
		},
	})
}

// fieldString reads a string field from the XADD value map.
func fieldString(values map[string]interface{}, key string) string {
	if v, ok := values[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// timestampFromID derives a timestamp from the millis portion of an entry id.
func timestampFromID(id string) time.Time {
	ms := id
	if i := strings.IndexByte(id, '-'); i >= 0 {
		ms = id[:i]
	}
	n, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return time.Now()
	}
	return time.UnixMilli(n)
}

// sleepCtx sleeps for d or until ctx is cancelled, returning ctx.Err() on cancel.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

var _ core.Consumer = (*Consumer)(nil)
var _ core.ConsumerHooks = (*Consumer)(nil)
