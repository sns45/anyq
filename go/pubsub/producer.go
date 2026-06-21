package pubsub

import (
	"context"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/pubsub"
	"github.com/google/uuid"
	"google.golang.org/api/option"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to a Google Cloud Pub/Sub topic.
type Producer struct {
	core.BaseProducer
	cfg    ProducerConfig
	client *pubsub.Client
	topic  *pubsub.Topic
}

// NewProducer builds a Pub/Sub producer.
func NewProducer(cfg ProducerConfig) *Producer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverGooglePubSub
	}
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// clientOptions builds the option list and applies emulator env handling shared
// by the producer and consumer.
func clientOptions(conn ConnectionConfig) []option.ClientOption {
	var opts []option.ClientOption
	if conn.KeyFilename != "" {
		opts = append(opts, option.WithCredentialsFile(conn.KeyFilename))
	}
	if conn.APIEndpoint != "" {
		opts = append(opts, option.WithEndpoint(conn.APIEndpoint))
	}
	// Mirror the TS behaviour: in emulator mode, set PUBSUB_EMULATOR_HOST so the
	// client talks to the emulator over insecure transport.
	if conn.EmulatorMode && conn.APIEndpoint != "" {
		host := strings.TrimPrefix(conn.APIEndpoint, "http://")
		host = strings.TrimPrefix(host, "https://")
		_ = os.Setenv("PUBSUB_EMULATOR_HOST", host)
	}
	return opts
}

// Connect creates the client and (optionally) ensures the topic exists.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}

	client, err := pubsub.NewClient(ctx, p.cfg.Connection.ProjectID, clientOptions(p.cfg.Connection)...)
	if err != nil {
		return core.NewConnectionError("failed to connect to Pub/Sub", err)
	}
	p.client = client

	topic := client.Topic(p.cfg.Topic.Name)
	topic.EnableMessageOrdering = p.cfg.Topic.EnableMessageOrdering

	b := p.cfg.Batching
	topic.PublishSettings.CountThreshold = pickInt(b != nil, batchMaxMessages(b), defaultBatchMaxMessages)
	topic.PublishSettings.ByteThreshold = pickInt(b != nil, batchMaxBytes(b), defaultBatchMaxBytes)
	topic.PublishSettings.DelayThreshold = time.Duration(pickInt(b != nil, batchMaxMillis(b), defaultBatchMaxMilliseconds)) * time.Millisecond
	p.topic = topic

	if boolOr(p.cfg.Topic.AutoCreate, true) {
		if err := p.ensureTopic(ctx); err != nil {
			_ = client.Close()
			p.client = nil
			p.topic = nil
			return core.NewConnectionError("failed to ensure topic", err)
		}
	}

	p.SetConnected(true)
	p.Logger.Info("Pub/Sub producer connected", map[string]any{
		"projectId": p.cfg.Connection.ProjectID,
		"topic":     p.cfg.Topic.Name,
	})
	return nil
}

func (p *Producer) ensureTopic(ctx context.Context) error {
	exists, err := p.topic.Exists(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	created, err := p.client.CreateTopic(ctx, p.cfg.Topic.Name)
	if err != nil {
		// Tolerate a concurrent create (AlreadyExists).
		if isAlreadyExists(err) {
			return nil
		}
		return err
	}
	created.EnableMessageOrdering = p.cfg.Topic.EnableMessageOrdering
	created.PublishSettings = p.topic.PublishSettings
	p.topic = created
	p.Logger.Info("Topic created", map[string]any{"topic": p.cfg.Topic.Name})
	return nil
}

// Disconnect flushes and closes the client.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	if p.topic != nil {
		p.topic.Stop() // flushes pending publishes
		p.topic = nil
	}
	if p.client != nil {
		_ = p.client.Close()
		p.client = nil
	}
	p.SetConnected(false)
	p.Logger.Info("Pub/Sub producer disconnected", nil)
	return nil
}

// Publish publishes a single message and returns the server-assigned message ID.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.topic == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}

	attrs := map[string]string{}
	if opts != nil {
		for k, v := range opts.Headers {
			attrs[k] = string(v)
		}
	}
	// Track the message with an anyq id, mirroring the TS adapter.
	attrs["anyq-message-id"] = uuid.NewString()

	msg := &pubsub.Message{Data: body, Attributes: attrs}
	// Only set an ordering key when the topic actually has message ordering
	// enabled; otherwise Pub/Sub rejects the publish. Key is a routing hint and
	// is not used as an ordering key unless ordering is enabled.
	if opts != nil && p.cfg.Topic.EnableMessageOrdering {
		switch {
		case opts.OrderingKey != "":
			msg.OrderingKey = opts.OrderingKey
		case opts.Key != "":
			msg.OrderingKey = opts.Key
		}
	}

	id, err := p.topic.Publish(ctx, msg).Get(ctx)
	if err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	p.Logger.Debug("Message published", map[string]any{"messageId": id, "topic": p.cfg.Topic.Name})
	return id, nil
}

// PublishBatch publishes several messages. Pub/Sub batches internally; results
// preserve input order.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.topic == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}

	results := make([]*pubsub.PublishResult, len(items))
	for i, item := range items {
		attrs := map[string]string{}
		if item.Options != nil {
			for k, v := range item.Options.Headers {
				attrs[k] = string(v)
			}
		}
		attrs["anyq-message-id"] = uuid.NewString()

		msg := &pubsub.Message{Data: item.Body, Attributes: attrs}
		if item.Options != nil && p.cfg.Topic.EnableMessageOrdering {
			switch {
			case item.Options.OrderingKey != "":
				msg.OrderingKey = item.Options.OrderingKey
			case item.Options.Key != "":
				msg.OrderingKey = item.Options.Key
			}
		}
		results[i] = p.topic.Publish(ctx, msg)
	}

	ids := make([]string, len(results))
	for i, r := range results {
		id, err := r.Get(ctx)
		if err != nil {
			return nil, core.NewPublishError("failed to publish batch", true, err)
		}
		ids[i] = id
	}
	p.Logger.Debug("Batch published", map[string]any{"count": len(ids), "topic": p.cfg.Topic.Name})
	return ids, nil
}

// Flush flushes pending buffered publishes.
func (p *Producer) Flush(ctx context.Context) error {
	if p.topic != nil {
		p.topic.Flush()
	}
	return nil
}

// HealthCheck reports producer health by verifying the topic exists.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if !p.IsConnected() || p.topic == nil {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	exists, err := p.topic.Exists(ctx)
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
		Connected: p.IsConnected(),
		LatencyMs: time.Since(start).Milliseconds(),
		Details: map[string]any{
			"topic":     p.cfg.Topic.Name,
			"projectId": p.cfg.Connection.ProjectID,
		},
	}, nil
}

func batchMaxMessages(b *BatchingConfig) int {
	if b != nil && b.MaxMessages > 0 {
		return b.MaxMessages
	}
	return defaultBatchMaxMessages
}

func batchMaxBytes(b *BatchingConfig) int {
	if b != nil && b.MaxBytes > 0 {
		return b.MaxBytes
	}
	return defaultBatchMaxBytes
}

func batchMaxMillis(b *BatchingConfig) int {
	if b != nil && b.MaxMilliseconds > 0 {
		return b.MaxMilliseconds
	}
	return defaultBatchMaxMilliseconds
}

func pickInt(cond bool, v, fallback int) int {
	if cond && v > 0 {
		return v
	}
	return fallback
}

// isAlreadyExists reports whether err is an AlreadyExists (code 6) gRPC error.
func isAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "alreadyexists") ||
		strings.Contains(err.Error(), "code = AlreadyExists")
}

var _ core.Producer = (*Producer)(nil)
