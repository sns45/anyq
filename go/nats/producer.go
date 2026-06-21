package nats

import (
	"context"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to NATS JetStream.
type Producer struct {
	core.BaseProducer
	cfg Config

	conn *nats.Conn
	js   jetstream.JetStream
}

// NewProducer builds a NATS JetStream producer.
func NewProducer(cfg Config) *Producer {
	cfg = cfg.withDefaults()
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect opens the connection, initialises JetStream and ensures the stream.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	conn, err := connect(p.cfg.Connection)
	if err != nil {
		return core.NewConnectionError("failed to connect to NATS", err)
	}
	js, err := jetstream.New(conn)
	if err != nil {
		conn.Close()
		return core.NewConnectionError("failed to initialise JetStream", err)
	}
	if err := ensureStream(ctx, js, p.cfg); err != nil {
		conn.Close()
		return core.NewConnectionError("failed to ensure stream", err)
	}
	p.conn = conn
	p.js = js
	p.SetConnected(true)
	p.Logger.Info("NATS producer connected", map[string]any{
		"servers": p.cfg.Connection.Servers,
		"stream":  p.cfg.JetStream.Stream,
		"subject": p.cfg.Subject,
	})
	return nil
}

// Disconnect drains the connection.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	if p.conn != nil {
		_ = p.conn.Drain()
		p.conn = nil
	}
	p.js = nil
	p.SetConnected(false)
	p.Logger.Info("NATS producer disconnected", nil)
	return nil
}

// Publish publishes a single message and returns its dedup message id.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.js == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}

	messageID := core.GenerateMessageID()
	subject := p.cfg.Subject
	if opts != nil && opts.Key != "" {
		subject = opts.Key
	}

	hdrs := nats.Header{}
	hdrs.Set(p.cfg.MsgIDHeader, messageID)
	if opts != nil {
		for k, v := range opts.Headers {
			hdrs.Set(k, string(v))
		}
	}

	msg := &nats.Msg{Subject: subject, Header: hdrs, Data: body}

	pubOpts := []jetstream.PublishOpt{jetstream.WithMsgID(messageID)}
	if p.cfg.ExpectedStream != "" {
		pubOpts = append(pubOpts, jetstream.WithExpectStream(p.cfg.ExpectedStream))
	}

	ack, err := p.js.PublishMsg(ctx, msg, pubOpts...)
	if err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	p.Logger.Debug("message published", map[string]any{
		"messageId": messageID, "subject": subject, "stream": ack.Stream, "seq": ack.Sequence,
	})
	return messageID, nil
}

// PublishBatch publishes several messages in order.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		id, err := p.Publish(ctx, item.Body, item.Options)
		if err != nil {
			return ids, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// HealthCheck reports producer health.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	if !p.IsConnected() || p.conn == nil || p.conn.IsClosed() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		Details:   map[string]any{"stream": p.cfg.JetStream.Stream, "subject": p.cfg.Subject},
	}, nil
}

var _ core.Producer = (*Producer)(nil)
