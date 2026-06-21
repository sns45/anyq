package memory

import (
	"context"
	"sync"
	"time"

	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from an in-memory queue. It is the reference
// implementation for the retry-strategy hooks: it supports native delayed
// redelivery (setTimeout-style re-enqueue) and native dead-lettering.
type Consumer struct {
	*core.BaseConsumer
	cfg                 Config
	queueName           string
	maxDeliveryAttempts int

	queue *Queue
	dlq   *Queue

	parkMu     sync.Mutex
	parkTimers map[*time.Timer]struct{}
}

// NewConsumer builds a memory consumer.
func NewConsumer(cfg Config) *Consumer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverMemory
	}
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)

	maxDel := 3
	if cfg.DeadLetterQueue != nil && cfg.DeadLetterQueue.MaxDeliveryAttempts > 0 {
		maxDel = cfg.DeadLetterQueue.MaxDeliveryAttempts
	}

	c := &Consumer{
		BaseConsumer:        bc,
		cfg:                 cfg,
		queueName:           cfg.queueName(),
		maxDeliveryAttempts: maxDel,
		parkTimers:          map[*time.Timer]struct{}{},
	}
	bc.Bind(c)
	return c
}

// SupportsNativeDelay: memory schedules delayed re-enqueue via timers.
func (c *Consumer) SupportsNativeDelay() bool { return true }

// Connect attaches to the queue and sets up the DLQ if configured.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	c.queue = GetOrCreateQueue(c.queueName, c.cfg.MaxMessages, c.cfg.MaxAgeMs)

	if dlqCfg := c.cfg.DeadLetterQueue; dlqCfg != nil && dlqCfg.Enabled {
		dlqName := dlqCfg.Destination
		if dlqName == "" {
			dlqName = c.queueName + "-dlq"
		}
		c.dlq = GetOrCreateQueue(dlqName, 0, 0)
	}

	c.SetConnected(true)
	c.Logger.Info("memory consumer connected", map[string]any{"queue": c.queueName})
	return nil
}

// Disconnect stops park timers and marks disconnected.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	c.parkMu.Lock()
	for t := range c.parkTimers {
		t.Stop()
	}
	c.parkTimers = map[*time.Timer]struct{}{}
	c.parkMu.Unlock()

	c.SetConnected(false)
	c.Logger.Info("memory consumer disconnected", nil)
	return nil
}

// DeadLetterMessage routes via Queue.DeadLetter so DLQ death headers are set.
func (c *Consumer) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	stored, _ := msg.Raw().(*StoredMessage)
	if c.queue != nil && c.dlq != nil && stored != nil {
		c.queue.DeadLetter(stored.ID, c.dlq, reason)
		c.Logger.Warn("message dead-lettered", map[string]any{"messageId": msg.ID(), "reason": reason})
		return nil
	}
	c.Logger.Warn("no DLQ configured; dropping message", map[string]any{"messageId": msg.ID(), "reason": reason})
	return msg.Nack(ctx, false)
}

// ParkMessage re-enqueues the message body after delayMs (native delay).
func (c *Consumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	if c.queue == nil {
		c.Logger.Warn("parkMessage called without a connected queue", map[string]any{"messageId": msg.ID()})
		return msg.Nack(ctx, false)
	}
	// Remove the in-flight copy so it doesn't linger in processing.
	if stored, ok := msg.Raw().(*StoredMessage); ok {
		c.queue.Ack(stored.ID)
	}

	body := msg.Body()
	key := msg.Key()
	headers := core.MessageHeaders{}
	for k, v := range msg.Headers() {
		headers[k] = v
	}

	var timer *time.Timer
	timer = time.AfterFunc(time.Duration(delayMs)*time.Millisecond, func() {
		c.parkMu.Lock()
		delete(c.parkTimers, timer)
		c.parkMu.Unlock()
		c.queue.Enqueue(body, key, headers)
	})
	c.parkMu.Lock()
	c.parkTimers[timer] = struct{}{}
	c.parkMu.Unlock()

	c.Logger.Debug("message parked for redelivery", map[string]any{"messageId": msg.ID(), "delayMs": delayMs})
	return nil
}

// Subscribe consumes messages until ctx is cancelled or a Fail decision occurs.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.queue == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to queue", map[string]any{"queue": c.queueName})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 5*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}
		stored := c.queue.Dequeue()
		if stored == nil {
			if !sleepOrDone(ctx, 5*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}
		msg := c.wrap(stored)
		if err := c.handleOne(ctx, handler, msg, stored, autoAck); err != nil {
			return err
		}
	}
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, msg core.Message, stored *StoredMessage, autoAck bool) error {
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
		return applyErr // fatal: Fail decision or context cancellation
	}
	if handled {
		return nil
	}

	// Legacy behaviour: DLQ after maxDeliveryAttempts, otherwise requeue.
	c.Logger.Error("error processing message", map[string]any{"messageId": stored.ID, "error": herr.Error()})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	if stored.DeliveryAttempt >= c.maxDeliveryAttempts && c.dlq != nil {
		c.queue.DeadLetter(stored.ID, c.dlq, herr.Error())
		c.Logger.Warn("message sent to DLQ", map[string]any{"messageId": stored.ID, "attempts": stored.DeliveryAttempt})
		return nil
	}
	return msg.Nack(ctx, true)
}

// SubscribeBatch consumes message batches until ctx is cancelled.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.queue == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	batchSize := 10
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	autoAck := opts.AutoAckEnabled()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 5*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}
		storedBatch := c.queue.DequeueBatch(batchSize)
		if len(storedBatch) == 0 {
			if !sleepOrDone(ctx, 5*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}
		msgs := make([]core.Message, len(storedBatch))
		for i, s := range storedBatch {
			msgs[i] = c.wrap(s)
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
				for _, m := range msgs {
					_ = m.Nack(ctx, true)
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

// HealthCheck reports consumer health.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	connected := c.IsConnected()
	details := map[string]any{"queue": c.queueName, "paused": c.IsPaused()}
	if c.queue != nil {
		details["queueSize"] = c.queue.Size()
		details["processing"] = c.queue.ProcessingCount()
	}
	return core.HealthStatus{Healthy: connected, Connected: connected, Details: details}, nil
}

// Queue returns the underlying queue (for testing).
func (c *Consumer) Queue() *Queue { return c.queue }

// DLQ returns the dead-letter queue, if configured (for testing).
func (c *Consumer) DLQ() *Queue { return c.dlq }

func (c *Consumer) wrap(stored *StoredMessage) core.Message {
	return core.NewMessage(core.MessageParams{
		ID:              stored.ID,
		Body:            stored.Body,
		Key:             stored.Key,
		Headers:         stored.Headers,
		Timestamp:       stored.Timestamp,
		DeliveryAttempt: stored.DeliveryAttempt,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverMemory,
			Memory:   &core.MemoryMetadata{QueueName: c.queueName},
		},
		Raw: stored,
		OnAck: func(context.Context) error {
			c.queue.Ack(stored.ID)
			return nil
		},
		OnNack: func(_ context.Context, requeue bool) error {
			c.queue.Nack(stored.ID, requeue)
			return nil
		},
	})
}

// sleepOrDone sleeps for d, returning false if ctx is cancelled first.
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

var _ core.Consumer = (*Consumer)(nil)
var _ core.ConsumerHooks = (*Consumer)(nil)
