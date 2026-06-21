package rabbitmq

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from a RabbitMQ queue. It embeds *core.BaseConsumer
// and wires handler failures into ApplyStrategy, preserving the TypeScript
// legacy catch behaviour in the !handled branch.
//
// Capability notes (matching the shipped TS adapter):
//   - SupportsNativeDelay is false: a Park decision downgrades to in-process
//     retry (the base handles this).
//   - DeadLetterMessage is not overridden: the base default warns and nacks
//     without requeue, which lets the queue's x-dead-letter-exchange (when
//     configured via QueueConfig.DeadLetterExchange) route the message.
type Consumer struct {
	*core.BaseConsumer
	cfg ConsumerConfig

	conn        *amqp.Connection
	channel     *amqp.Channel
	consumerTag string
}

// NewConsumer builds a RabbitMQ consumer.
func NewConsumer(cfg ConsumerConfig) *Consumer {
	cfg.applyDefaults()
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)
	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	bc.Bind(c)
	return c
}

// Connect dials the broker, opens a channel, sets QoS, declares the queue, and
// optionally declares and binds the configured exchange.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}

	conn, err := amqp.DialConfig(dialURL(c.cfg.Connection), amqp.Config{
		Heartbeat:  c.cfg.Connection.Heartbeat,
		Dial:       amqp.DefaultDial(c.cfg.Connection.ConnectionTimeout),
		ChannelMax: uint16(c.cfg.Connection.ChannelMax),
		FrameSize:  c.cfg.Connection.FrameMax,
	})
	if err != nil {
		return core.NewConnectionError("failed to connect to RabbitMQ", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return core.NewConnectionError("failed to open RabbitMQ channel", err)
	}

	if err := ch.Qos(c.cfg.Consumer.Prefetch, 0, false); err != nil {
		_ = ch.Close()
		_ = conn.Close()
		return core.NewConnectionError("failed to set prefetch", err)
	}

	args := c.queueArgs()
	if _, err := ch.QueueDeclare(
		c.cfg.Queue.Name,
		c.cfg.Queue.Durable,
		c.cfg.Queue.AutoDelete,
		c.cfg.Queue.Exclusive,
		false,
		args,
	); err != nil {
		_ = ch.Close()
		_ = conn.Close()
		return core.NewConnectionError("failed to declare queue", err)
	}

	if c.cfg.Exchange != nil {
		if err := ch.ExchangeDeclare(
			c.cfg.Exchange.Name,
			c.cfg.Exchange.Type,
			c.cfg.Exchange.Durable,
			c.cfg.Exchange.AutoDelete,
			c.cfg.Exchange.Internal,
			false,
			amqp.Table(c.cfg.Exchange.Arguments),
		); err != nil {
			_ = ch.Close()
			_ = conn.Close()
			return core.NewConnectionError("failed to declare exchange", err)
		}
		if err := ch.QueueBind(c.cfg.Queue.Name, c.cfg.BindingKey, c.cfg.Exchange.Name, false, nil); err != nil {
			_ = ch.Close()
			_ = conn.Close()
			return core.NewConnectionError("failed to bind queue", err)
		}
	}

	c.conn = conn
	c.channel = ch
	c.SetConnected(true)
	exchangeName := ""
	if c.cfg.Exchange != nil {
		exchangeName = c.cfg.Exchange.Name
	}
	c.Logger.Info("RabbitMQ consumer connected", map[string]any{
		"queue": c.cfg.Queue.Name, "exchange": exchangeName,
	})
	return nil
}

func (c *Consumer) queueArgs() amqp.Table {
	args := amqp.Table{}
	q := c.cfg.Queue
	if q.DeadLetterExchange != "" {
		args["x-dead-letter-exchange"] = q.DeadLetterExchange
		if q.DeadLetterRoutingKey != "" {
			args["x-dead-letter-routing-key"] = q.DeadLetterRoutingKey
		}
	}
	if q.MessageTTL > 0 {
		args["x-message-ttl"] = int32(q.MessageTTL)
	}
	if q.MaxLength > 0 {
		args["x-max-length"] = int32(q.MaxLength)
	}
	if q.MaxLengthBytes > 0 {
		args["x-max-length-bytes"] = int32(q.MaxLengthBytes)
	}
	for k, v := range q.Arguments {
		args[k] = v
	}
	if len(args) == 0 {
		return nil
	}
	return args
}

// Disconnect cancels the consumer and closes the channel and connection.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	if c.channel != nil && c.consumerTag != "" {
		_ = c.channel.Cancel(c.consumerTag, false)
		c.consumerTag = ""
	}
	if c.channel != nil {
		_ = c.channel.Close()
		c.channel = nil
	}
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.SetConnected(false)
	c.Logger.Info("RabbitMQ consumer disconnected", nil)
	return nil
}

// Subscribe consumes deliveries with a per-message handler. It blocks until ctx
// is cancelled, the deliveries channel closes, or a strategy Fail decision
// returns a fatal error.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.channel == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}

	deliveries, err := c.channel.ConsumeWithContext(
		ctx,
		c.cfg.Queue.Name,
		c.cfg.Consumer.ConsumerTag,
		c.cfg.Consumer.NoAck,
		c.cfg.Consumer.Exclusive,
		c.cfg.Consumer.NoLocal,
		false,
		c.consumeArgs(),
	)
	if err != nil {
		return core.NewConsumeError("failed to start consuming", err)
	}
	autoAck := opts.AutoAckEnabled()
	c.Logger.Info("subscribed to queue", map[string]any{"queue": c.cfg.Queue.Name})

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				return ctx.Err()
			}
			if c.IsPaused() {
				_ = d.Nack(false, true)
				continue
			}
			if err := c.handleOne(ctx, handler, d, autoAck); err != nil {
				return err
			}
		}
	}
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, d amqp.Delivery, autoAck bool) error {
	msg := c.wrap(d)
	herr := handler(ctx, msg)
	if herr == nil {
		if autoAck && !c.cfg.Consumer.NoAck {
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

	// Legacy catch behaviour (preserved from the TS adapter): log the error and
	// nack with requeue so the broker (or its dead-letter-exchange) can retry.
	c.Logger.Error("error processing message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	return msg.Nack(ctx, true)
}

// SubscribeBatch consumes deliveries and dispatches them to a batch handler. It
// fills batches up to BatchSize or until BatchTimeout elapses.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.channel == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}

	deliveries, err := c.channel.ConsumeWithContext(
		ctx,
		c.cfg.Queue.Name,
		c.cfg.Consumer.ConsumerTag,
		false, // always manual ack for batch
		c.cfg.Consumer.Exclusive,
		c.cfg.Consumer.NoLocal,
		false,
		c.consumeArgs(),
	)
	if err != nil {
		return core.NewConsumeError("failed to start consuming", err)
	}

	batchSize := 10
	batchTimeout := 5 * time.Second
	if opts != nil {
		if opts.BatchSize > 0 {
			batchSize = opts.BatchSize
		}
		if opts.BatchTimeout > 0 {
			batchTimeout = opts.BatchTimeout
		}
	}
	autoAck := opts.AutoAckEnabled()

	var batch []amqp.Delivery
	timer := time.NewTimer(batchTimeout)
	timer.Stop()
	defer timer.Stop()

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		current := batch
		batch = nil
		timer.Stop()
		return c.handleBatch(ctx, handler, current, autoAck)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if err := flush(); err != nil {
				return err
			}
		case d, ok := <-deliveries:
			if !ok {
				return ctx.Err()
			}
			if c.IsPaused() {
				_ = d.Nack(false, true)
				continue
			}
			if len(batch) == 0 {
				timer.Reset(batchTimeout)
			}
			batch = append(batch, d)
			if len(batch) >= batchSize {
				if err := flush(); err != nil {
					return err
				}
			}
		}
	}
}

func (c *Consumer) handleBatch(ctx context.Context, handler core.BatchHandler, deliveries []amqp.Delivery, autoAck bool) error {
	msgs := make([]core.Message, len(deliveries))
	for i, d := range deliveries {
		msgs[i] = c.wrap(d)
	}

	herr := handler(ctx, msgs)
	if herr == nil {
		if autoAck {
			for _, m := range msgs {
				_ = m.Ack(ctx)
			}
		}
		return nil
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
		for _, m := range msgs {
			_ = m.Nack(ctx, true)
		}
	}
	return nil
}

func (c *Consumer) consumeArgs() amqp.Table {
	args := amqp.Table{}
	if c.cfg.Consumer.Priority != 0 {
		args["x-priority"] = int32(c.cfg.Consumer.Priority)
	}
	for k, v := range c.cfg.Consumer.Arguments {
		args[k] = v
	}
	if len(args) == 0 {
		return nil
	}
	return args
}

func (c *Consumer) wrap(d amqp.Delivery) core.Message {
	messageID := d.MessageId
	if messageID == "" {
		messageID = "rmq-" + itoa(int(d.DeliveryTag))
	}
	ts := d.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}
	// RabbitMQ does not expose a delivery-attempt counter; mirror the TS adapter
	// which reports 2 for redelivered messages and 1 otherwise.
	deliveryAttempt := 1
	if d.Redelivered {
		deliveryAttempt = 2
	}

	headers := core.MessageHeaders{}
	for k, v := range d.Headers {
		headers[k] = headerBytes(v)
	}

	return core.NewMessage(core.MessageParams{
		ID:              messageID,
		Body:            d.Body,
		Key:             d.RoutingKey,
		Headers:         headers,
		Timestamp:       ts,
		DeliveryAttempt: deliveryAttempt,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverRabbitMQ,
			RabbitMQ: &core.RabbitMQMetadata{
				Exchange:    d.Exchange,
				RoutingKey:  d.RoutingKey,
				ConsumerTag: d.ConsumerTag,
				DeliveryTag: d.DeliveryTag,
				Redelivered: d.Redelivered,
			},
		},
		Raw: d,
		OnAck: func(context.Context) error {
			return d.Ack(false)
		},
		OnNack: func(_ context.Context, requeue bool) error {
			return d.Nack(false, requeue)
		},
	})
}

// HealthCheck reports consumer health.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if !c.IsConnected() || c.channel == nil {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	exchangeName := ""
	if c.cfg.Exchange != nil {
		exchangeName = c.cfg.Exchange.Name
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"queue": c.cfg.Queue.Name, "exchange": exchangeName, "paused": c.IsPaused()},
	}, nil
}

// headerBytes coerces an AMQP header value into bytes.
func headerBytes(v any) []byte {
	switch t := v.(type) {
	case []byte:
		return t
	case string:
		return []byte(t)
	case nil:
		return nil
	default:
		return []byte(stringify(t))
	}
}

func stringify(v any) string {
	switch t := v.(type) {
	case int:
		return itoa(t)
	case int32:
		return itoa(int(t))
	case int64:
		return itoa(int(t))
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

var (
	_ core.Consumer      = (*Consumer)(nil)
	_ core.ConsumerHooks = (*Consumer)(nil)
)
