package kafka

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	kafkago "github.com/segmentio/kafka-go"
	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from a Kafka topic using a kafka-go Reader bound to
// a consumer group.
//
// Offset/commit model: this adapter uses Reader.FetchMessage (which does NOT
// auto-commit) and commits explicitly via Reader.CommitMessages once a message
// has been processed successfully (or resolved by the retry strategy). This is
// the Go-idiomatic way to get manual-ack semantics out of kafka-go and mirrors
// the TS adapter's onAck=commit / onNack=no-commit behaviour. Because commits
// are offset-based and monotonic, a successful commit of offset N implicitly
// covers everything below N on that partition.
type Consumer struct {
	*core.BaseConsumer

	cfg    Config
	reader *kafkago.Reader
}

// NewConsumer builds a Kafka consumer and binds it to BaseConsumer so
// ApplyStrategy dispatches to this adapter's hook overrides.
func NewConsumer(cfg Config) *Consumer {
	cfg.applyDefaults()
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)
	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	bc.Bind(c)
	return c
}

func (c *Consumer) groupID() string {
	if c.cfg.ConsumerGroup != nil && c.cfg.ConsumerGroup.GroupID != "" {
		return c.cfg.ConsumerGroup.GroupID
	}
	return "anyq-consumer-group"
}

// Connect builds the Reader.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	d, err := dialer(&c.cfg)
	if err != nil {
		return core.NewConnectionError("failed to configure kafka dialer", err)
	}

	rc := kafkago.ReaderConfig{
		Brokers: c.cfg.Brokers,
		GroupID: c.groupID(),
		Topic:   c.cfg.Topic,
		Dialer:  d,
		// CommitInterval 0 => synchronous commits via CommitMessages (manual ack).
		CommitInterval: 0,
	}
	if g := c.cfg.ConsumerGroup; g != nil {
		if g.SessionTimeoutMs > 0 {
			rc.SessionTimeout = time.Duration(g.SessionTimeoutMs) * time.Millisecond
		}
		if g.HeartbeatIntervalMs > 0 {
			rc.HeartbeatInterval = time.Duration(g.HeartbeatIntervalMs) * time.Millisecond
		}
		if g.MinBytes > 0 {
			rc.MinBytes = g.MinBytes
		}
		if g.MaxBytes > 0 {
			rc.MaxBytes = g.MaxBytes
		}
		if g.MaxWaitMs > 0 {
			rc.MaxWait = time.Duration(g.MaxWaitMs) * time.Millisecond
		}
		if g.FromBeginning {
			rc.StartOffset = kafkago.FirstOffset
		} else {
			rc.StartOffset = kafkago.LastOffset
		}
	}

	c.reader = kafkago.NewReader(rc)
	c.SetConnected(true)
	c.Logger.Info("kafka consumer connected", map[string]any{
		"topic": c.cfg.Topic, "groupId": c.groupID(), "brokers": c.cfg.Brokers,
	})
	return nil
}

// Disconnect closes the Reader.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	if c.reader != nil {
		_ = c.reader.Close()
		c.reader = nil
	}
	c.SetConnected(false)
	c.Logger.Info("kafka consumer disconnected", nil)
	return nil
}

// wrap builds a core.Message for a fetched kafka-go message. OnAck commits the
// offset; OnNack is a no-op (Kafka has no per-message nack; not committing means
// the offset will be re-delivered after a rebalance or restart).
func (c *Consumer) wrap(km kafkago.Message) core.Message {
	headers := core.MessageHeaders{}
	for _, h := range km.Headers {
		headers[h.Key] = h.Value
	}
	offsetStr := strconv.FormatInt(km.Offset, 10)
	id := fmt.Sprintf("%s-%d-%d", km.Topic, km.Partition, km.Offset)

	return core.NewMessage(core.MessageParams{
		ID:              id,
		Body:            km.Value,
		Key:             string(km.Key),
		Headers:         headers,
		Timestamp:       km.Time,
		DeliveryAttempt: 1, // Kafka has no native redelivery counter.
		Metadata: core.ProviderMetadata{
			Provider: core.DriverKafka,
			Kafka: &core.KafkaMetadata{
				Topic:         km.Topic,
				Partition:     km.Partition,
				Offset:        offsetStr,
				HighWatermark: strconv.FormatInt(km.HighWaterMark, 10),
				Key:           string(km.Key),
			},
		},
		Raw: km,
		OnAck: func(ackCtx context.Context) error {
			if c.reader == nil {
				return nil
			}
			return c.reader.CommitMessages(ackCtx, km)
		},
		OnNack: func(_ context.Context, _ bool) error {
			// No native nack. Leaving the offset uncommitted lets Kafka redeliver
			// from the last committed offset on the next assignment.
			c.Logger.Debug("message nacked (offset left uncommitted)", map[string]any{"messageId": id})
			return nil
		},
	})
}

// Subscribe consumes messages one at a time until ctx is cancelled or a fatal
// (Fail) strategy decision occurs.
//
// On handler success the offset is committed (auto-ack). On handler error the
// configured retry strategy runs via ApplyStrategy; if no strategy is configured
// the legacy catch behaviour runs: log + emit error, then skip the message
// (commit) so a poison message does not stall the partition (mirrors the TS
// autocommit semantics where a thrown handler still advances the offset).
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.reader == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to topic", map[string]any{"topic": c.cfg.Topic, "groupId": c.groupID()})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 50*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		km, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				return ctx.Err()
			}
			return core.NewConsumeError("failed to fetch message", err)
		}

		msg := c.wrap(km)
		if err := c.handleOne(ctx, handler, msg, km, autoAck); err != nil {
			return err
		}
	}
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, msg core.Message, km kafkago.Message, autoAck bool) error {
	herr := handler(ctx, msg)
	if herr == nil {
		if autoAck {
			return msg.Ack(ctx) // commit offset
		}
		return nil
	}

	reinvoke := func() error { return handler(ctx, msg) }
	handled, applyErr := c.ApplyStrategy(ctx, msg, herr, reinvoke)
	if applyErr != nil {
		return applyErr // fatal: Fail decision or context cancellation
	}
	if handled {
		// Strategy resolved the message (ack/dead-letter/requeue/park-downgrade).
		// Commit so the loop advances past it.
		return c.commit(ctx, km)
	}

	// Legacy behaviour (no strategy configured): preserve the TS catch block.
	// The TS adapter logs the error, emits 'error', and (because Kafka autocommit
	// is on) advances past the message. We mirror that by committing the offset.
	c.Logger.Error("error processing message", map[string]any{
		"topic":     km.Topic,
		"partition": km.Partition,
		"offset":    km.Offset,
		"error":     herr.Error(),
	})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	return c.commit(ctx, km)
}

func (c *Consumer) commit(ctx context.Context, kms ...kafkago.Message) error {
	if c.reader == nil || len(kms) == 0 {
		return nil
	}
	if err := c.reader.CommitMessages(ctx, kms...); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.NewConsumeError("failed to commit offset", err)
	}
	return nil
}

// SubscribeBatch consumes messages in batches. Kafka batch handling is
// offset-based and therefore ALL-OR-NOTHING: a batch is built by fetching up to
// BatchSize messages, the handler is invoked for the whole slice, and the retry
// strategy applies to the batch as a single unit (using the first message as the
// representative, mirroring the TS adapter). On success the highest offset is
// committed, which implicitly commits the whole batch.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.reader == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	batchSize := 10
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	batchTimeout := time.Second
	if opts != nil && opts.BatchTimeout > 0 {
		batchTimeout = opts.BatchTimeout
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to topic (batch)", map[string]any{"topic": c.cfg.Topic, "groupId": c.groupID()})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 50*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		kms, fetchErr := c.fetchBatch(ctx, batchSize, batchTimeout)
		if fetchErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return core.NewConsumeError("failed to fetch batch", fetchErr)
		}
		if len(kms) == 0 {
			continue
		}

		msgs := make([]core.Message, len(kms))
		for i, km := range kms {
			msgs[i] = c.wrap(km)
		}

		if herr := handler(ctx, msgs); herr != nil {
			// All-or-nothing: apply the strategy to the batch via its first message.
			reinvoke := func() error { return handler(ctx, msgs) }
			handled, applyErr := c.ApplyStrategy(ctx, msgs[0], herr, reinvoke)
			if applyErr != nil {
				return applyErr
			}
			if !handled {
				// Legacy: log + emit, then advance past the batch (autocommit).
				c.Logger.Error("error processing batch", map[string]any{
					"topic": c.cfg.Topic, "count": len(msgs), "error": herr.Error(),
				})
				if c.Config.OnError != nil {
					c.Config.OnError(herr)
				}
			}
			if err := c.commit(ctx, kms...); err != nil {
				return err
			}
			continue
		}

		if autoAck {
			if err := c.commit(ctx, kms...); err != nil {
				return err
			}
		}
	}
}

// fetchBatch pulls up to n messages, returning early once batchTimeout elapses
// after the first message (so a partially-filled batch is still delivered).
func (c *Consumer) fetchBatch(ctx context.Context, n int, timeout time.Duration) ([]kafkago.Message, error) {
	out := make([]kafkago.Message, 0, n)
	// First fetch blocks on the parent ctx.
	km, err := c.reader.FetchMessage(ctx)
	if err != nil {
		return nil, err
	}
	out = append(out, km)

	deadline := time.Now().Add(timeout)
	for len(out) < n {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		fctx, cancel := context.WithTimeout(ctx, remaining)
		km, err := c.reader.FetchMessage(fctx)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return out, ctx.Err()
			}
			// Timeout filling the batch: deliver what we have.
			break
		}
		out = append(out, km)
	}
	return out, nil
}

// Pause stops fetching new messages (the Subscribe loop checks IsPaused).
func (c *Consumer) Pause(ctx context.Context) error {
	return c.BaseConsumer.Pause(ctx)
}

// Resume resumes fetching.
func (c *Consumer) Resume(ctx context.Context) error {
	return c.BaseConsumer.Resume(ctx)
}

// HealthCheck reports consumer health based on connection state.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	connected := c.IsConnected()
	details := map[string]any{
		"topic":   c.cfg.Topic,
		"groupId": c.groupID(),
		"paused":  c.IsPaused(),
	}
	if c.reader != nil {
		details["lag"] = c.reader.Lag()
	}
	return core.HealthStatus{Healthy: connected, Connected: connected, Details: details}, nil
}

// GetLag implements core.Lagger. It reports the kafka-go Reader's cached lag for
// the partition currently assigned to this group member.
//
// Capability note: kafka-go's ReadLag/Offset accessors are only available on a
// partition-bound (non-group) reader; with a consumer group they return an
// error. Reader.Lag() returns the cached value computed during normal reads, so
// we surface that aggregate value. A full per-partition breakdown across all
// group members would require an admin client and is not implemented here
// (mirrors the scope of the 0.3.0 TS adapter, which also surfaces only basic
// lag detail).
func (c *Consumer) GetLag(ctx context.Context) (core.ConsumerLag, error) {
	if c.reader == nil {
		return core.ConsumerLag{}, core.NewConnectionError("consumer not connected", nil)
	}
	lag := c.reader.Lag()
	return core.ConsumerLag{
		TotalLag: lag,
		Partitions: []core.PartitionLag{
			{Lag: lag},
		},
	}, nil
}

// Seek implements core.Seeker. Only timestamp-based seeks are supported on a
// group reader (kafka-go applies SetOffsetAt by resolving offsets per assigned
// partition). Beginning/End/explicit-offset seeks require a partition-bound
// reader, which this consumer-group adapter does not use, so they return
// ErrNotSupported. This matches the underlying client's group constraints.
func (c *Consumer) Seek(ctx context.Context, pos core.SeekPosition) error {
	if c.reader == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	if pos.Timestamp != nil {
		return c.reader.SetOffsetAt(ctx, *pos.Timestamp)
	}
	// Beginning/End/explicit offset are not available with a consumer-group
	// reader in kafka-go (they return errNotAvailableWithGroup).
	return core.ErrNotSupported
}

// Reader returns the underlying kafka-go Reader (for testing).
func (c *Consumer) Reader() *kafkago.Reader { return c.reader }

func sleepOrDone(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

var (
	_ core.Consumer      = (*Consumer)(nil)
	_ core.ConsumerHooks = (*Consumer)(nil)
	_ core.Lagger        = (*Consumer)(nil)
	_ core.Seeker        = (*Consumer)(nil)
)
