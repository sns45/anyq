package azureservicebus

import (
	"context"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to an Azure Service Bus queue or topic.
type Producer struct {
	core.BaseProducer
	cfg    Config
	client *azservicebus.Client
	sender *azservicebus.Sender
	entity string
}

// NewProducer builds an Azure Service Bus producer.
func NewProducer(cfg Config) *Producer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverAzureServiceBus
	}
	p := &Producer{cfg: cfg, entity: cfg.senderEntity()}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect creates the Service Bus client and a sender for the queue/topic.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	if p.cfg.Queue == nil && p.cfg.Topic == nil {
		return core.NewConnectionError("azure service bus producer requires a queue or topic", nil)
	}
	if p.cfg.Connection.ConnectionString == "" {
		return core.NewConnectionError("azure service bus producer requires a connection string", nil)
	}

	client, err := azservicebus.NewClientFromConnectionString(p.cfg.Connection.ConnectionString, nil)
	if err != nil {
		return core.NewConnectionError("failed to connect to Azure Service Bus", err)
	}

	entity := p.cfg.senderEntity()
	if entity == "" {
		_ = client.Close(ctx)
		return core.NewConnectionError("no queue or topic name specified", nil)
	}

	sender, err := client.NewSender(entity, nil)
	if err != nil {
		_ = client.Close(ctx)
		return core.NewConnectionError("failed to create Service Bus sender", err)
	}

	p.client = client
	p.sender = sender
	p.entity = entity
	p.SetConnected(true)
	kind := "queue"
	if p.cfg.Topic != nil {
		kind = "topic"
	}
	p.Logger.Info("Azure Service Bus producer connected", map[string]any{"entity": entity, "type": kind})
	return nil
}

// Disconnect closes the sender and client.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	if p.sender != nil {
		if err := p.sender.Close(ctx); err != nil {
			p.Logger.Error("error closing sender", map[string]any{"error": err.Error()})
		}
		p.sender = nil
	}
	if p.client != nil {
		if err := p.client.Close(ctx); err != nil {
			p.Logger.Error("error closing client", map[string]any{"error": err.Error()})
		}
		p.client = nil
	}
	p.SetConnected(false)
	p.Logger.Info("Azure Service Bus producer disconnected", nil)
	return nil
}

// Publish sends a single message and returns its message id.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.sender == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}
	msg, id := buildMessage(body, opts)
	if err := p.sender.SendMessage(ctx, msg, nil); err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	p.Logger.Debug("message published", map[string]any{"messageId": id, "entity": p.entity})
	return id, nil
}

// PublishBatch sends multiple messages, packing them into SDK message batches.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.sender == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}

	ids := make([]string, 0, len(items))
	batch, err := p.sender.NewMessageBatch(ctx, nil)
	if err != nil {
		return nil, core.NewPublishError("failed to create message batch", true, err)
	}

	for _, item := range items {
		msg, id := buildMessage(item.Body, item.Options)
		addErr := batch.AddMessage(msg, nil)
		if addErr == azservicebus.ErrMessageTooLarge {
			// Current batch is full: send it, start a new one, and re-add.
			if batch.NumMessages() == 0 {
				return ids, core.NewPublishError("message too large for an empty batch", false, addErr)
			}
			if err := p.sender.SendMessageBatch(ctx, batch, nil); err != nil {
				return ids, core.NewPublishError("failed to publish batch", true, err)
			}
			batch, err = p.sender.NewMessageBatch(ctx, nil)
			if err != nil {
				return ids, core.NewPublishError("failed to create message batch", true, err)
			}
			if addErr = batch.AddMessage(msg, nil); addErr != nil {
				return ids, core.NewPublishError("failed to add message to batch", false, addErr)
			}
		} else if addErr != nil {
			return ids, core.NewPublishError("failed to add message to batch", false, addErr)
		}
		ids = append(ids, id)
	}

	if batch.NumMessages() > 0 {
		if err := p.sender.SendMessageBatch(ctx, batch, nil); err != nil {
			return ids, core.NewPublishError("failed to publish batch", true, err)
		}
	}

	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "entity": p.entity})
	return ids, nil
}

// Flush is a no-op: Azure Service Bus sends messages immediately.
func (p *Producer) Flush(ctx context.Context) error { return nil }

// HealthCheck reports producer health.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if p.sender == nil || !p.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	kind := "queue"
	if p.cfg.Topic != nil {
		kind = "topic"
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"entity": p.entity, "type": kind},
	}, nil
}

// Client returns the underlying client (for testing).
func (p *Producer) Client() *azservicebus.Client { return p.client }

// buildMessage maps a body + PublishOptions to an azservicebus.Message, returning
// the generated message id.
func buildMessage(body []byte, opts *core.PublishOptions) (*azservicebus.Message, string) {
	id := core.GenerateMessageID()
	contentType := "application/json"
	msg := &azservicebus.Message{
		MessageID:   &id,
		Body:        body,
		ContentType: &contentType,
	}
	if opts == nil {
		return msg, id
	}

	// Map groupId to SessionID, key to PartitionKey (mirrors the TS adapter).
	if opts.GroupID != "" {
		gid := opts.GroupID
		msg.SessionID = &gid
	}
	if opts.Key != "" {
		pk := opts.Key
		msg.PartitionKey = &pk
	}
	if opts.CorrelationID != "" {
		cid := opts.CorrelationID
		msg.CorrelationID = &cid
	}
	if opts.ReplyTo != "" {
		rt := opts.ReplyTo
		msg.ReplyTo = &rt
	}
	if opts.TTL > 0 {
		ttl := opts.TTL
		msg.TimeToLive = &ttl
	}
	if len(opts.Headers) > 0 {
		props := make(map[string]any, len(opts.Headers))
		for k, v := range opts.Headers {
			props[k] = string(v)
		}
		msg.ApplicationProperties = props
	}
	// Native scheduled delivery for a publish-time delay.
	if opts.Delay > 0 {
		t := time.Now().Add(opts.Delay)
		msg.ScheduledEnqueueTime = &t
	}
	return msg, id
}

var _ core.Producer = (*Producer)(nil)
