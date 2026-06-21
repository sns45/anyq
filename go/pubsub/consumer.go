package pubsub

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/pubsub"

	"github.com/sns45/anyq/go/core"
)

// Consumer receives messages from a Google Cloud Pub/Sub subscription.
//
// Pub/Sub uses streaming pull: Subscription.Receive invokes the callback
// concurrently from multiple goroutines. Each delivery is wrapped in its own
// core.Message (with per-message OnAck/OnNack), so there is no shared mutable
// per-message state across callbacks. ApplyStrategy operates only on the message
// passed to it, so concurrent invocation is safe; the only shared state
// (pause flag, circuit breaker, logger) is already synchronised by the core
// base types.
type Consumer struct {
	*core.BaseConsumer
	cfg    ConsumerConfig
	client *pubsub.Client
	sub    *pubsub.Subscription
}

// NewConsumer builds a Pub/Sub consumer.
func NewConsumer(cfg ConsumerConfig) *Consumer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverGooglePubSub
	}
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)

	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	bc.Bind(c)
	return c
}

// Connect creates the client and ensures the subscription exists.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}

	client, err := pubsub.NewClient(ctx, c.cfg.Connection.ProjectID, clientOptions(c.cfg.Connection)...)
	if err != nil {
		return core.NewConnectionError("failed to connect to Pub/Sub", err)
	}
	c.client = client

	sub := client.Subscription(c.cfg.Subscription.Name)
	fc := c.cfg.Subscription.FlowControl
	if fc != nil && fc.MaxMessages > 0 {
		sub.ReceiveSettings.MaxOutstandingMessages = fc.MaxMessages
	} else {
		sub.ReceiveSettings.MaxOutstandingMessages = defaultFlowControlMessages
	}
	if fc != nil && fc.MaxBytes > 0 {
		sub.ReceiveSettings.MaxOutstandingBytes = fc.MaxBytes
	} else {
		sub.ReceiveSettings.MaxOutstandingBytes = defaultFlowControlBytes
	}
	c.sub = sub

	if boolOr(c.cfg.Subscription.AutoCreate, true) {
		if err := c.ensureSubscription(ctx); err != nil {
			_ = client.Close()
			c.client = nil
			c.sub = nil
			return core.NewConnectionError("failed to ensure subscription", err)
		}
	}

	c.SetConnected(true)
	c.Logger.Info("Pub/Sub consumer connected", map[string]any{
		"projectId":    c.cfg.Connection.ProjectID,
		"subscription": c.cfg.Subscription.Name,
	})
	return nil
}

func (c *Consumer) ensureSubscription(ctx context.Context) error {
	exists, err := c.sub.Exists(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	if c.cfg.TopicName == "" {
		return fmt.Errorf("topic name required for auto-creating subscription")
	}

	// Ensure the topic exists first.
	topic := c.client.Topic(c.cfg.TopicName)
	topicExists, err := topic.Exists(ctx)
	if err != nil {
		return err
	}
	if !topicExists {
		topic, err = c.client.CreateTopic(ctx, c.cfg.TopicName)
		if err != nil && !isAlreadyExists(err) {
			return err
		}
		if err == nil {
			c.Logger.Info("Topic created", map[string]any{"topic": c.cfg.TopicName})
		}
	}

	subCfg := pubsub.SubscriptionConfig{Topic: topic}
	if d := c.cfg.Subscription.AckDeadlineSeconds; d > 0 {
		subCfg.AckDeadline = time.Duration(d) * time.Second
	} else {
		subCfg.AckDeadline = time.Duration(defaultAckDeadlineSeconds) * time.Second
	}
	subCfg.EnableExactlyOnceDelivery = c.cfg.Subscription.ExactlyOnceDelivery
	if dlp := c.cfg.Subscription.DeadLetterPolicy; dlp != nil && dlp.DeadLetterTopic != "" {
		subCfg.DeadLetterPolicy = &pubsub.DeadLetterPolicy{
			DeadLetterTopic:     fmt.Sprintf("projects/%s/topics/%s", c.cfg.Connection.ProjectID, dlp.DeadLetterTopic),
			MaxDeliveryAttempts: dlp.MaxDeliveryAttempts,
		}
	}
	if rp := c.cfg.Subscription.RetryPolicy; rp != nil {
		subCfg.RetryPolicy = &pubsub.RetryPolicy{
			MinimumBackoff: time.Duration(rp.MinimumBackoffSeconds) * time.Second,
			MaximumBackoff: time.Duration(rp.MaximumBackoffSeconds) * time.Second,
		}
	}

	created, err := c.client.CreateSubscription(ctx, c.cfg.Subscription.Name, subCfg)
	if err != nil {
		if isAlreadyExists(err) {
			return nil
		}
		return err
	}
	created.ReceiveSettings = c.sub.ReceiveSettings
	c.sub = created
	c.Logger.Info("Subscription created", map[string]any{"subscription": c.cfg.Subscription.Name})
	return nil
}

// Disconnect closes the client. The active Receive call is stopped by cancelling
// the context passed to Subscribe.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	if c.client != nil {
		_ = c.client.Close()
		c.client = nil
	}
	c.sub = nil
	c.SetConnected(false)
	c.Logger.Info("Pub/Sub consumer disconnected", nil)
	return nil
}

// Subscribe consumes messages until ctx is cancelled. The callback is invoked
// concurrently by the Pub/Sub client.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.sub == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	c.Logger.Info("Subscribed to messages", map[string]any{"subscription": c.cfg.Subscription.Name})

	err := c.sub.Receive(ctx, func(cbCtx context.Context, m *pubsub.Message) {
		if c.IsPaused() {
			// Nack to redeliver later while paused.
			m.Nack()
			return
		}
		msg := c.wrap(m)
		c.handleOne(cbCtx, handler, msg, m)
	})
	if err != nil && ctx.Err() == nil {
		c.Logger.Error("Subscription error", map[string]any{"error": err.Error()})
		c.emit(err)
	}
	return err
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, msg core.Message, raw *pubsub.Message) {
	if herr := handler(ctx, msg); herr != nil {
		reinvoke := func() error { return handler(ctx, msg) }
		handled, applyErr := c.ApplyStrategy(ctx, msg, herr, reinvoke)
		if applyErr != nil {
			// Fail decision or context cancellation: log; ApplyStrategy has not
			// acked/nacked, so the message redelivers per the subscription policy.
			c.Logger.Error("retry strategy terminated processing", map[string]any{
				"messageId": msg.ID(), "error": applyErr.Error(),
			})
			raw.Nack()
			return
		}
		if handled {
			return
		}
		// Legacy behaviour: nack so the message is redelivered.
		c.Logger.Error("Error processing message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
		if c.Config.OnError != nil {
			c.Config.OnError(herr)
		}
		raw.Nack()
		return
	}
	// Success: ack.
	_ = msg.Ack(ctx)
}

// SubscribeBatch buffers messages into batches and dispatches them to handler.
// Pub/Sub delivers messages one at a time via Receive, so batches are assembled
// in-process.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.sub == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	batchSize := 10
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	batchTimeout := 5 * time.Second
	if opts != nil && opts.BatchTimeout > 0 {
		batchTimeout = opts.BatchTimeout
	}

	b := newBatcher(c, handler, batchSize, batchTimeout)
	defer b.stop()

	c.Logger.Info("Subscribed to messages (batch mode)", map[string]any{
		"subscription": c.cfg.Subscription.Name,
		"batchSize":    batchSize,
		"batchTimeout": batchTimeout.String(),
	})

	err := c.sub.Receive(ctx, func(cbCtx context.Context, m *pubsub.Message) {
		if c.IsPaused() {
			m.Nack()
			return
		}
		b.add(cbCtx, c.wrap(m), m)
	})
	if err != nil && ctx.Err() == nil {
		c.Logger.Error("Subscription error", map[string]any{"error": err.Error()})
		c.emit(err)
	}
	return err
}

// wrap converts a Pub/Sub message into a core.Message with ack/nack wired back.
func (c *Consumer) wrap(m *pubsub.Message) core.Message {
	headers := core.MessageHeaders{}
	for k, v := range m.Attributes {
		headers[k] = []byte(v)
	}

	deliveryAttempt := 1
	if m.DeliveryAttempt != nil && *m.DeliveryAttempt > 0 {
		deliveryAttempt = *m.DeliveryAttempt
	}

	return core.NewMessage(core.MessageParams{
		ID:              m.ID,
		Body:            m.Data,
		Key:             m.OrderingKey,
		Headers:         headers,
		Timestamp:       m.PublishTime,
		DeliveryAttempt: deliveryAttempt,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverGooglePubSub,
			GooglePubSub: &core.GooglePubSubMetadata{
				Subscription: c.cfg.Subscription.Name,
				PublishTime:  m.PublishTime,
				OrderingKey:  m.OrderingKey,
			},
		},
		Raw: m,
		OnAck: func(context.Context) error {
			m.Ack()
			c.Logger.Debug("Message acknowledged", map[string]any{"messageId": m.ID})
			return nil
		},
		OnNack: func(_ context.Context, _ bool) error {
			m.Nack()
			c.Logger.Debug("Message negatively acknowledged", map[string]any{"messageId": m.ID})
			return nil
		},
	})
}

// emit invokes the configured OnError callback (the Go analogue of the TS
// 'error' event).
func (c *Consumer) emit(err error) {
	if c.Config.OnError != nil {
		c.Config.OnError(err)
	}
}

// HealthCheck reports consumer health by verifying the subscription exists.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if !c.IsConnected() || c.sub == nil {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	exists, err := c.sub.Exists(ctx)
	if err != nil {
		return core.HealthStatus{
			Healthy:   false,
			Connected: false,
			LatencyMs: time.Since(start).Milliseconds(),
			Error:     err.Error(),
		}, nil
	}
	return core.HealthStatus{
		Healthy:   exists,
		Connected: c.IsConnected(),
		LatencyMs: time.Since(start).Milliseconds(),
		Details: map[string]any{
			"subscription": c.cfg.Subscription.Name,
			"projectId":    c.cfg.Connection.ProjectID,
			"paused":       c.IsPaused(),
		},
	}, nil
}

var (
	_ core.Consumer      = (*Consumer)(nil)
	_ core.ConsumerHooks = (*Consumer)(nil)
)
