package kafka

import (
	"context"
	"fmt"
	"time"

	kafkago "github.com/segmentio/kafka-go"
	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to a Kafka topic using a kafka-go Writer.
type Producer struct {
	core.BaseProducer

	cfg    Config
	writer *kafkago.Writer
}

// NewProducer builds a Kafka producer.
func NewProducer(cfg Config) *Producer {
	cfg.applyDefaults()
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

func compressionFor(name string) kafkago.Compression {
	switch name {
	case "gzip":
		return kafkago.Gzip
	case "snappy":
		return kafkago.Snappy
	case "lz4":
		return kafkago.Lz4
	case "zstd":
		return kafkago.Zstd
	default:
		return 0 // none
	}
}

// requiredAcks maps the TS acks values (-1/0/1) to kafka-go RequiredAcks.
func requiredAcks(opts *ProducerOptions) kafkago.RequiredAcks {
	if opts == nil {
		return kafkago.RequireAll
	}
	switch opts.Acks {
	case 0:
		return kafkago.RequireNone
	case 1:
		return kafkago.RequireOne
	default:
		return kafkago.RequireAll
	}
}

// Connect builds the Writer.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	tr, err := transport(&p.cfg)
	if err != nil {
		return core.NewConnectionError("failed to configure kafka transport", err)
	}

	w := &kafkago.Writer{
		Addr:                   kafkago.TCP(p.cfg.Brokers...),
		Topic:                  p.cfg.Topic,
		Balancer:               &kafkago.Hash{}, // route by key when present
		RequiredAcks:           requiredAcks(p.cfg.Producer),
		Compression:            compressionFor(compressionName(p.cfg.Producer)),
		AllowAutoTopicCreation: true,
		Transport:              tr,
	}
	if p.cfg.Producer != nil {
		if p.cfg.Producer.BatchSize > 0 {
			w.BatchSize = p.cfg.Producer.BatchSize
		}
		if p.cfg.Producer.BatchTimeoutMs > 0 {
			w.BatchTimeout = time.Duration(p.cfg.Producer.BatchTimeoutMs) * time.Millisecond
		}
	}

	p.writer = w
	p.SetConnected(true)
	p.Logger.Info("kafka producer connected", map[string]any{
		"topic": p.cfg.Topic, "brokers": p.cfg.Brokers,
	})
	return nil
}

func compressionName(opts *ProducerOptions) string {
	if opts == nil {
		return "none"
	}
	return opts.Compression
}

// Disconnect closes the Writer.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	if p.writer != nil {
		_ = p.writer.Close()
		p.writer = nil
	}
	p.SetConnected(false)
	p.Logger.Info("kafka producer disconnected", nil)
	return nil
}

// buildMessage maps a body + PublishOptions to a kafka-go Message.
func buildMessage(body []byte, opts *core.PublishOptions) kafkago.Message {
	m := kafkago.Message{Value: body}
	if opts != nil {
		if opts.Key != "" {
			m.Key = []byte(opts.Key)
		}
		if opts.Partition != nil {
			m.Partition = *opts.Partition
		}
		for k, v := range opts.Headers {
			m.Headers = append(m.Headers, kafkago.Header{Key: k, Value: v})
		}
	}
	return m
}

// Publish sends a single message. The returned id is "topic-partition-offset".
// kafka-go does not surface the assigned partition/offset from WriteMessages, so
// the id encodes the topic and key only (offset is broker-assigned).
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.writer == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}
	msg := buildMessage(body, opts)
	if err := p.writer.WriteMessages(ctx, msg); err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	key := ""
	if opts != nil {
		key = opts.Key
	}
	id := messageID(p.cfg.Topic, key)
	p.Logger.Debug("message published", map[string]any{"messageId": id, "topic": p.cfg.Topic})
	return id, nil
}

// PublishBatch sends multiple messages in a single WriteMessages call.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.writer == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}
	msgs := make([]kafkago.Message, len(items))
	ids := make([]string, len(items))
	for i, item := range items {
		msgs[i] = buildMessage(item.Body, item.Options)
		key := ""
		if item.Options != nil {
			key = item.Options.Key
		}
		ids[i] = messageID(p.cfg.Topic, key)
	}
	if err := p.writer.WriteMessages(ctx, msgs...); err != nil {
		return nil, core.NewPublishError("failed to publish batch", true, err)
	}
	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "topic": p.cfg.Topic})
	return ids, nil
}

// Flush is a no-op: kafka-go Writer.WriteMessages is synchronous (writes are
// flushed by the time it returns unless Async is set, which this adapter does
// not enable).
func (p *Producer) Flush(ctx context.Context) error { return nil }

// HealthCheck reports producer health based on connection state.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	connected := p.IsConnected()
	return core.HealthStatus{
		Healthy:   connected,
		Connected: connected,
		Details:   map[string]any{"topic": p.cfg.Topic},
	}, nil
}

func messageID(topic, key string) string {
	if key != "" {
		return fmt.Sprintf("%s-%s", topic, key)
	}
	return topic
}

var _ core.Producer = (*Producer)(nil)
