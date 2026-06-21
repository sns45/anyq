package rabbitmq

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to a RabbitMQ exchange. It mirrors the TypeScript
// RabbitMQProducer: it asserts the configured exchange on connect and publishes
// with publisher confirms when ConfirmMode is enabled.
type Producer struct {
	core.BaseProducer
	cfg ProducerConfig

	conn    *amqp.Connection
	channel *amqp.Channel
}

// NewProducer builds a RabbitMQ producer.
func NewProducer(cfg ProducerConfig) *Producer {
	cfg.applyDefaults()
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect dials the broker, opens a channel, optionally enables confirms, and
// asserts the exchange.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}

	conn, err := amqp.DialConfig(dialURL(p.cfg.Connection), amqp.Config{
		Heartbeat:  p.cfg.Connection.Heartbeat,
		Dial:       amqp.DefaultDial(p.cfg.Connection.ConnectionTimeout),
		ChannelMax: uint16(p.cfg.Connection.ChannelMax),
		FrameSize:  p.cfg.Connection.FrameMax,
	})
	if err != nil {
		return core.NewConnectionError("failed to connect to RabbitMQ", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return core.NewConnectionError("failed to open RabbitMQ channel", err)
	}

	if p.cfg.ConfirmMode {
		if err := ch.Confirm(false); err != nil {
			_ = ch.Close()
			_ = conn.Close()
			return core.NewConnectionError("failed to enable publisher confirms", err)
		}
	}

	if p.cfg.Exchange.Name != "" {
		if err := ch.ExchangeDeclare(
			p.cfg.Exchange.Name,
			p.cfg.Exchange.Type,
			p.cfg.Exchange.Durable,
			p.cfg.Exchange.AutoDelete,
			p.cfg.Exchange.Internal,
			false,
			amqp.Table(p.cfg.Exchange.Arguments),
		); err != nil {
			_ = ch.Close()
			_ = conn.Close()
			return core.NewConnectionError("failed to declare exchange", err)
		}
	}

	p.conn = conn
	p.channel = ch
	p.SetConnected(true)
	p.Logger.Info("RabbitMQ producer connected", map[string]any{
		"exchange": p.cfg.Exchange.Name,
		"type":     p.cfg.Exchange.Type,
	})
	return nil
}

// Disconnect closes the channel and connection.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	if p.channel != nil {
		_ = p.channel.Close()
		p.channel = nil
	}
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
	p.SetConnected(false)
	p.Logger.Info("RabbitMQ producer disconnected", nil)
	return nil
}

// Publish sends a single message. The routing key is options.Key, falling back
// to the configured RoutingKey. When ConfirmMode is enabled the publish waits
// for a broker confirm bounded by ConfirmTimeout.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.channel == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}

	messageID := core.GenerateMessageID()
	routingKey := p.cfg.RoutingKey
	var headers core.MessageHeaders
	var priority uint8
	var correlationID, replyTo, expiration string
	if opts != nil {
		if opts.Key != "" {
			routingKey = opts.Key
		}
		headers = opts.Headers
		if opts.Priority != nil {
			priority = *opts.Priority
		}
		correlationID = opts.CorrelationID
		replyTo = opts.ReplyTo
		if opts.TTL > 0 {
			expiration = itoa(int(opts.TTL / time.Millisecond))
		}
	}

	deliveryMode := uint8(amqp.Persistent)
	if !p.cfg.Persistent {
		deliveryMode = amqp.Transient
	}

	pub := amqp.Publishing{
		Headers:       toTable(headers),
		ContentType:   "application/json",
		DeliveryMode:  deliveryMode,
		Priority:      priority,
		CorrelationId: correlationID,
		ReplyTo:       replyTo,
		Expiration:    expiration,
		MessageId:     messageID,
		Timestamp:     time.Now(),
		Body:          body,
	}

	if p.cfg.ConfirmMode {
		conf, err := p.channel.PublishWithDeferredConfirmWithContext(
			ctx, p.cfg.Exchange.Name, routingKey, p.cfg.Mandatory, false, pub)
		if err != nil {
			return "", core.NewPublishError("failed to publish message", true, err)
		}
		confirmCtx := ctx
		if p.cfg.ConfirmTimeout > 0 {
			var cancel context.CancelFunc
			confirmCtx, cancel = context.WithTimeout(ctx, p.cfg.ConfirmTimeout)
			defer cancel()
		}
		acked, err := conf.WaitContext(confirmCtx)
		if err != nil {
			return "", core.NewPublishError("publish confirm wait failed", true, err)
		}
		if !acked {
			return "", core.NewPublishError("publish nacked by broker", true, nil)
		}
	} else {
		if err := p.channel.PublishWithContext(
			ctx, p.cfg.Exchange.Name, routingKey, p.cfg.Mandatory, false, pub); err != nil {
			return "", core.NewPublishError("failed to publish message", true, err)
		}
	}

	p.Logger.Debug("message published", map[string]any{
		"messageId": messageID, "exchange": p.cfg.Exchange.Name, "routingKey": routingKey,
	})
	return messageID, nil
}

// PublishBatch publishes each item in order and returns the assigned ids.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.channel == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		id, err := p.Publish(ctx, item.Body, item.Options)
		if err != nil {
			return ids, err
		}
		ids = append(ids, id)
	}
	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "exchange": p.cfg.Exchange.Name})
	return ids, nil
}

// Flush is a no-op: each Publish already waits for its confirm when ConfirmMode
// is enabled.
func (p *Producer) Flush(ctx context.Context) error { return nil }

// HealthCheck reports producer health.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if !p.IsConnected() || p.channel == nil {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"exchange": p.cfg.Exchange.Name, "type": p.cfg.Exchange.Type},
	}, nil
}

// toTable converts core MessageHeaders ([]byte values) into an amqp.Table.
func toTable(h core.MessageHeaders) amqp.Table {
	if len(h) == 0 {
		return nil
	}
	t := make(amqp.Table, len(h))
	for k, v := range h {
		t[k] = string(v)
	}
	return t
}

var _ core.Producer = (*Producer)(nil)
