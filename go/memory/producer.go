package memory

import (
	"context"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to an in-memory queue.
type Producer struct {
	core.BaseProducer
	queueName string
	cfg       Config
	queue     *Queue
}

// NewProducer builds a memory producer.
func NewProducer(cfg Config) *Producer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverMemory
	}
	p := &Producer{queueName: cfg.queueName(), cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect attaches to (or creates) the named queue.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	p.queue = GetOrCreateQueue(p.queueName, p.cfg.MaxMessages, p.cfg.MaxAgeMs)
	p.SetConnected(true)
	p.Logger.Info("memory producer connected", map[string]any{"queue": p.queueName})
	return nil
}

// Disconnect detaches from the queue.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	p.queue = nil
	p.SetConnected(false)
	p.Logger.Info("memory producer disconnected", nil)
	return nil
}

// Publish enqueues a single message.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.queue == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}
	var key string
	var headers core.MessageHeaders
	if opts != nil {
		key = opts.Key
		headers = opts.Headers
	}
	id := p.queue.Enqueue(body, key, headers)
	p.Logger.Debug("message published", map[string]any{"messageId": id, "queue": p.queueName})
	return id, nil
}

// PublishBatch enqueues several messages.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.queue == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		var key string
		var headers core.MessageHeaders
		if item.Options != nil {
			key = item.Options.Key
			headers = item.Options.Headers
		}
		ids = append(ids, p.queue.Enqueue(item.Body, key, headers))
	}
	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "queue": p.queueName})
	return ids, nil
}

// HealthCheck reports producer health.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	connected := p.IsConnected()
	details := map[string]any{"queue": p.queueName}
	if p.queue != nil {
		details["queueSize"] = p.queue.Size()
	}
	return core.HealthStatus{Healthy: connected, Connected: connected, Details: details}, nil
}

// Queue returns the underlying queue (for testing).
func (p *Producer) Queue() *Queue { return p.queue }

var _ core.Producer = (*Producer)(nil)
