package sqs

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/sns45/anyq/go/core"
)

// Producer publishes messages to an AWS SQS queue.
type Producer struct {
	core.BaseProducer
	cfg    Config
	client *sqs.Client
}

// NewProducer builds an SQS producer.
func NewProducer(cfg Config) *Producer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverSQS
	}
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect builds the SQS client.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}
	client, err := buildClient(ctx, p.cfg.SQS, p.cfg.region())
	if err != nil {
		return core.NewConnectionError("failed to connect to SQS", err)
	}
	p.client = client
	p.SetConnected(true)
	p.Logger.Info("SQS producer connected", map[string]any{
		"queueUrl": p.cfg.QueueURL, "region": p.cfg.region(),
	})
	return nil
}

// Disconnect releases the SQS client.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	p.client = nil
	p.SetConnected(false)
	p.Logger.Info("SQS producer disconnected", nil)
	return nil
}

// Publish sends a single message and returns its SQS message id.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.client == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}

	input := &sqs.SendMessageInput{
		QueueUrl:          aws.String(p.cfg.QueueURL),
		MessageBody:       aws.String(string(body)),
		DelaySeconds:      p.resolveDelaySeconds(opts),
		MessageAttributes: headersToAttributes(opts),
	}

	if p.cfg.FIFO {
		input.MessageGroupId = aws.String(p.resolveGroupID(opts))
		input.MessageDeduplicationId = aws.String(p.resolveDedupID(opts))
	}

	out, err := p.client.SendMessage(ctx, input)
	if err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}
	id := aws.ToString(out.MessageId)
	if id == "" {
		id = fmt.Sprintf("sqs-%d", time.Now().UnixMilli())
	}
	p.Logger.Debug("message published", map[string]any{"messageId": id, "queueUrl": p.cfg.QueueURL})
	return id, nil
}

// PublishBatch sends multiple messages in batches of 10 (the SQS limit).
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	if p.client == nil {
		return nil, core.NewConnectionError("producer not connected", nil)
	}

	ids := make([]string, 0, len(items))
	for start := 0; start < len(items); start += 10 {
		end := start + 10
		if end > len(items) {
			end = len(items)
		}
		chunk := items[start:end]

		entries := make([]types.SendMessageBatchRequestEntry, 0, len(chunk))
		for i, item := range chunk {
			entry := types.SendMessageBatchRequestEntry{
				Id:                aws.String(fmt.Sprintf("msg-%d", i)),
				MessageBody:       aws.String(string(item.Body)),
				DelaySeconds:      p.resolveDelaySeconds(item.Options),
				MessageAttributes: headersToAttributes(item.Options),
			}
			if p.cfg.FIFO {
				entry.MessageGroupId = aws.String(p.resolveGroupID(item.Options))
				entry.MessageDeduplicationId = aws.String(fmt.Sprintf("%d-%d-%d", time.Now().UnixNano(), i, rand.Int()))
			}
			entries = append(entries, entry)
		}

		out, err := p.client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{
			QueueUrl: aws.String(p.cfg.QueueURL),
			Entries:  entries,
		})
		if err != nil {
			return ids, core.NewPublishError("failed to publish batch", true, err)
		}
		for _, s := range out.Successful {
			id := aws.ToString(s.MessageId)
			if id == "" {
				id = fmt.Sprintf("sqs-batch-%d", time.Now().UnixMilli())
			}
			ids = append(ids, id)
		}
		if len(out.Failed) > 0 {
			p.Logger.Warn("some messages failed to publish", map[string]any{"failed": len(out.Failed)})
		}
	}

	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "queueUrl": p.cfg.QueueURL})
	return ids, nil
}

// HealthCheck reports producer health.
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if p.client == nil || !p.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"queueUrl": p.cfg.QueueURL, "fifo": p.cfg.FIFO},
	}, nil
}

// Client returns the underlying SQS client (for testing).
func (p *Producer) Client() *sqs.Client { return p.client }

func (p *Producer) resolveDelaySeconds(opts *core.PublishOptions) int32 {
	if opts != nil && opts.Delay > 0 {
		return clampDelaySeconds(int(opts.Delay / time.Second))
	}
	return p.cfg.Producer.DelaySeconds
}

func (p *Producer) resolveGroupID(opts *core.PublishOptions) string {
	if opts != nil {
		if opts.GroupID != "" {
			return opts.GroupID
		}
		if opts.Key != "" {
			return opts.Key
		}
	}
	if p.cfg.Producer.MessageGroupID != "" {
		return p.cfg.Producer.MessageGroupID
	}
	return "default"
}

func (p *Producer) resolveDedupID(opts *core.PublishOptions) string {
	if opts != nil && opts.DeduplicationID != "" {
		return opts.DeduplicationID
	}
	if p.cfg.Producer.MessageDeduplicationID != "" {
		return p.cfg.Producer.MessageDeduplicationID
	}
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), rand.Int())
}

// headersToAttributes maps message headers to SQS message attributes as String
// values (mirrors the TS producer).
func headersToAttributes(opts *core.PublishOptions) map[string]types.MessageAttributeValue {
	if opts == nil || len(opts.Headers) == 0 {
		return nil
	}
	attrs := make(map[string]types.MessageAttributeValue, len(opts.Headers))
	for k, v := range opts.Headers {
		attrs[k] = types.MessageAttributeValue{
			DataType:    aws.String("String"),
			StringValue: aws.String(string(v)),
		}
	}
	return attrs
}

// clampDelaySeconds clamps a delay (in seconds) to the SQS valid range 0-900.
func clampDelaySeconds(s int) int32 {
	if s < 0 {
		return 0
	}
	if s > 900 {
		return 900
	}
	return int32(s)
}

var _ core.Producer = (*Producer)(nil)
