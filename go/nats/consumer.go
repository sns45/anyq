package nats

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from NATS JetStream.
//
// It supports native delayed redelivery: the Park retry decision is satisfied
// with JetStream NakWithDelay (mirroring the TS jsMsg.nak(delayMs) override).
type Consumer struct {
	*core.BaseConsumer
	cfg Config

	conn     *nats.Conn
	js       jetstream.JetStream
	consumer jetstream.Consumer
}

// NewConsumer builds a NATS JetStream consumer.
func NewConsumer(cfg Config) *Consumer {
	cfg = cfg.withDefaults()
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)
	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	bc.Bind(c)
	return c
}

// SupportsNativeDelay reports that JetStream can schedule a delayed redelivery
// via NakWithDelay.
func (c *Consumer) SupportsNativeDelay() bool { return true }

// ParkMessage schedules a delayed redelivery using NakWithDelay on the
// underlying JetStream message (mirrors TS jsMsg.nak(delayMs)). When the raw
// handle is missing it falls back to a requeueing nack.
func (c *Consumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	jsMsg, ok := msg.Raw().(jetstream.Msg)
	if !ok || jsMsg == nil {
		c.Logger.Warn("parkMessage missing JsMsg; falling back to nack", map[string]any{"messageId": msg.ID()})
		return msg.Nack(ctx, true)
	}
	if err := jsMsg.NakWithDelay(time.Duration(delayMs) * time.Millisecond); err != nil {
		c.Logger.Error("NATS nak(delay) failed; falling back to nack", map[string]any{
			"messageId": msg.ID(), "error": err.Error(),
		})
		return msg.Nack(ctx, true)
	}
	c.Logger.Debug("message parked for redelivery", map[string]any{"messageId": msg.ID(), "delayMs": delayMs})
	return nil
}

// Connect opens the connection, initialises JetStream and ensures the stream.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	conn, err := connect(c.cfg.Connection)
	if err != nil {
		return core.NewConnectionError("failed to connect to NATS", err)
	}
	js, err := jetstream.New(conn)
	if err != nil {
		conn.Close()
		return core.NewConnectionError("failed to initialise JetStream", err)
	}
	if err := ensureStream(ctx, js, c.cfg); err != nil {
		conn.Close()
		return core.NewConnectionError("failed to ensure stream", err)
	}
	c.conn = conn
	c.js = js
	c.SetConnected(true)
	c.Logger.Info("NATS consumer connected", map[string]any{
		"servers": c.cfg.Connection.Servers,
		"stream":  c.cfg.JetStream.Stream,
		"subject": c.cfg.Subject,
	})
	return nil
}

// Disconnect drains the connection.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	if c.conn != nil {
		_ = c.conn.Drain()
		c.conn = nil
	}
	c.js = nil
	c.consumer = nil
	c.SetConnected(false)
	c.Logger.Info("NATS consumer disconnected", nil)
	return nil
}

// ensureConsumer creates (or fetches) the durable consumer on the stream.
func (c *Consumer) ensureConsumer(ctx context.Context, durable string) (jetstream.Consumer, error) {
	co := c.cfg.Consumer
	filter := co.FilterSubject
	if filter == "" {
		filter = c.cfg.Subject
	}
	cfg := jetstream.ConsumerConfig{
		Durable:       durable,
		Description:   co.Description,
		DeliverPolicy: deliverPolicy(co.DeliverPolicy),
		OptStartSeq:   co.OptStartSeq,
		OptStartTime:  co.OptStartTime,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       co.AckWait,
		MaxDeliver:    co.MaxDeliver,
		FilterSubject: filter,
		MaxAckPending: co.MaxAckPending,
		ReplayPolicy:  replayPolicy(co.ReplayPolicy),
	}
	return c.js.CreateOrUpdateConsumer(ctx, c.cfg.JetStream.Stream, cfg)
}

func (c *Consumer) durableName() string {
	if c.cfg.Consumer.DurableName != "" {
		return c.cfg.Consumer.DurableName
	}
	return "consumer-" + core.GenerateMessageID()
}

// Subscribe consumes messages until ctx is cancelled or a fatal Fail decision.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.js == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	consumer, err := c.ensureConsumer(ctx, c.durableName())
	if err != nil {
		return core.NewConsumeError("failed to ensure consumer", err)
	}
	c.consumer = consumer
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to JetStream", map[string]any{"stream": c.cfg.JetStream.Stream, "subject": c.cfg.Subject})

	iter, err := consumer.Messages()
	if err != nil {
		return core.NewConsumeError("failed to start consume", err)
	}
	defer iter.Stop()

	// Stop the iterator when the context is cancelled so Next unblocks.
	stop := context.AfterFunc(ctx, iter.Stop)
	defer stop()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		jsMsg, err := iter.Next()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, jetstream.ErrMsgIteratorClosed) {
				return ctx.Err()
			}
			c.Logger.Error("consumer loop error", map[string]any{"error": err.Error()})
			return core.NewConsumeError("consume iterator error", err)
		}

		if c.IsPaused() {
			// Redeliver later while paused.
			_ = jsMsg.Nak()
			continue
		}

		msg := c.convert(jsMsg)
		if herr := handler(ctx, msg); herr != nil {
			reinvoke := func() error { return handler(ctx, msg) }
			handled, applyErr := c.ApplyStrategy(ctx, msg, herr, reinvoke)
			if applyErr != nil {
				return applyErr // fatal: Fail decision or context cancellation
			}
			if !handled {
				// Legacy: redelivery governed by maxDeliver config.
				c.Logger.Error("error processing message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
				if c.Config.OnError != nil {
					c.Config.OnError(herr)
				}
			}
			continue
		}
		if autoAck {
			if err := msg.Ack(ctx); err != nil {
				c.Logger.Error("ack failed", map[string]any{"messageId": msg.ID(), "error": err.Error()})
			}
		}
	}
}

// SubscribeBatch consumes message batches until ctx is cancelled.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.js == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	consumer, err := c.ensureConsumer(ctx, c.durableName())
	if err != nil {
		return core.NewConsumeError("failed to ensure consumer", err)
	}
	c.consumer = consumer
	autoAck := opts.AutoAckEnabled()

	batchSize := c.cfg.Consumer.Batch
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	batchTimeout := c.cfg.Consumer.Expires
	if opts != nil && opts.BatchTimeout > 0 {
		batchTimeout = opts.BatchTimeout
	}
	c.Logger.Info("subscribed to JetStream (batch mode)", map[string]any{"stream": c.cfg.JetStream.Stream, "subject": c.cfg.Subject})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if err := sleepCtx(ctx, 5*time.Millisecond); err != nil {
				return err
			}
			continue
		}
		batch, err := consumer.Fetch(batchSize, jetstream.FetchMaxWait(batchTimeout))
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.Logger.Error("batch fetch error", map[string]any{"error": err.Error()})
			return core.NewConsumeError("batch fetch error", err)
		}

		var msgs []core.Message
		for jsMsg := range batch.Messages() {
			msgs = append(msgs, c.convert(jsMsg))
		}
		if err := batch.Error(); err != nil && ctx.Err() == nil {
			c.Logger.Error("batch error", map[string]any{"error": err.Error()})
		}
		if len(msgs) == 0 {
			continue
		}

		if herr := handler(ctx, msgs); herr != nil {
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
			continue
		}
		if autoAck {
			for _, m := range msgs {
				_ = m.Ack(ctx)
			}
		}
	}
}

// convert wraps a JetStream message in a core.Message.
func (c *Consumer) convert(jsMsg jetstream.Msg) core.Message {
	headers := core.MessageHeaders{}
	for k, vals := range jsMsg.Headers() {
		if len(vals) > 0 {
			headers[k] = []byte(vals[0])
		}
	}

	var (
		messageID       = jsMsg.Subject()
		seq             uint64
		ts              = time.Now()
		redeliveryCount int
	)
	if meta, err := jsMsg.Metadata(); err == nil {
		seq = meta.Sequence.Stream
		ts = meta.Timestamp
		if meta.NumDelivered > 0 {
			redeliveryCount = int(meta.NumDelivered) - 1
		}
		messageID = fmt.Sprintf("%d", meta.Sequence.Stream)
	}
	if id := jsMsg.Headers().Get(c.cfg.MsgIDHeader); id != "" {
		messageID = id
	}
	redelivered := redeliveryCount > 0
	deliveryAttempt := redeliveryCount + 1

	return core.NewMessage(core.MessageParams{
		ID:              messageID,
		Body:            jsMsg.Data(),
		Key:             jsMsg.Subject(),
		Headers:         headers,
		Timestamp:       ts,
		DeliveryAttempt: deliveryAttempt,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverNATS,
			NATS: &core.NATSMetadata{
				Stream:          c.cfg.JetStream.Stream,
				Subject:         jsMsg.Subject(),
				Sequence:        seq,
				Redelivered:     redelivered,
				RedeliveryCount: redeliveryCount,
			},
		},
		Raw: jsMsg,
		OnAck: func(context.Context) error {
			return jsMsg.Ack()
		},
		OnNack: func(_ context.Context, requeue bool) error {
			if requeue {
				return jsMsg.Nak()
			}
			// requeue=false -> terminate (no redelivery), mirroring TS jsMsg.term().
			return jsMsg.Term()
		},
		OnExtendDeadline: func(context.Context, time.Duration) error {
			return jsMsg.InProgress()
		},
	})
}

// HealthCheck reports consumer health.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	if !c.IsConnected() || c.conn == nil || c.conn.IsClosed() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		Details: map[string]any{
			"stream": c.cfg.JetStream.Stream, "subject": c.cfg.Subject, "paused": c.IsPaused(),
		},
	}, nil
}

// sleepCtx sleeps for d, returning ctx.Err() if cancelled first.
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
