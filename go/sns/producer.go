package sns

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"

	"github.com/sns45/anyq/go/core"
)

// snsAPI is the subset of the SNS client used by Producer. It allows the client
// to be stubbed in tests.
type snsAPI interface {
	Publish(ctx context.Context, in *sns.PublishInput, optFns ...func(*sns.Options)) (*sns.PublishOutput, error)
	PublishBatch(ctx context.Context, in *sns.PublishBatchInput, optFns ...func(*sns.Options)) (*sns.PublishBatchOutput, error)
}

// Producer publishes messages to an AWS SNS topic.
type Producer struct {
	core.BaseProducer

	cfg    Config
	client snsAPI
}

// NewProducer builds an SNS producer from config.
func NewProducer(cfg Config) *Producer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverSNS
	}
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	return p
}

// Connect builds the SNS client.
func (p *Producer) Connect(ctx context.Context) error {
	if p.IsConnected() {
		return nil
	}

	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if p.cfg.SNS.Region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(p.cfg.SNS.Region))
	}
	if p.cfg.SNS.AccessKeyID != "" && p.cfg.SNS.SecretAccessKey != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(p.cfg.SNS.AccessKeyID, p.cfg.SNS.SecretAccessKey, ""),
		))
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return core.NewConnectionError("failed to load AWS config for SNS", err)
	}

	p.client = sns.NewFromConfig(awsCfg, func(o *sns.Options) {
		if p.cfg.SNS.Endpoint != "" {
			o.BaseEndpoint = aws.String(p.cfg.SNS.Endpoint)
		}
	})

	p.SetConnected(true)
	p.Logger.Info("SNS producer connected", map[string]any{
		"topicArn": p.cfg.TopicArn,
		"region":   p.cfg.SNS.Region,
	})
	return nil
}

// Disconnect releases the client.
func (p *Producer) Disconnect(ctx context.Context) error {
	if !p.IsConnected() {
		return nil
	}
	p.client = nil
	p.SetConnected(false)
	p.Logger.Info("SNS producer disconnected", nil)
	return nil
}

// Publish sends a single message to the topic and returns the SNS message id.
func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	if p.client == nil {
		return "", core.NewConnectionError("producer not connected", nil)
	}

	in := &sns.PublishInput{
		TopicArn: aws.String(p.cfg.TopicArn),
		Message:  aws.String(string(body)),
	}
	if p.cfg.Producer.Subject != "" {
		in.Subject = aws.String(p.cfg.Producer.Subject)
	}
	if opts != nil && len(opts.Headers) > 0 {
		in.MessageAttributes = toMessageAttributes(opts.Headers)
	}
	if p.cfg.FIFO {
		in.MessageGroupId = aws.String(p.groupID(opts))
		in.MessageDeduplicationId = aws.String(p.dedupID(opts, 0))
	}

	out, err := p.client.Publish(ctx, in)
	if err != nil {
		return "", core.NewPublishError("failed to publish message", true, err)
	}

	id := aws.ToString(out.MessageId)
	if id == "" {
		id = fmt.Sprintf("sns-%d", time.Now().UnixNano())
	}
	p.Logger.Debug("message published", map[string]any{"messageId": id, "topicArn": p.cfg.TopicArn})
	return id, nil
}

// PublishBatch sends messages in batches of up to 10 (the SNS limit) and returns
// the resulting message ids in publish order.
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
		batch := items[start:end]

		entries := make([]snstypes.PublishBatchRequestEntry, 0, len(batch))
		for i, item := range batch {
			entry := snstypes.PublishBatchRequestEntry{
				Id:      aws.String(fmt.Sprintf("msg-%d", i)),
				Message: aws.String(string(item.Body)),
			}
			if p.cfg.Producer.Subject != "" {
				entry.Subject = aws.String(p.cfg.Producer.Subject)
			}
			if item.Options != nil && len(item.Options.Headers) > 0 {
				entry.MessageAttributes = toMessageAttributes(item.Options.Headers)
			}
			if p.cfg.FIFO {
				entry.MessageGroupId = aws.String(p.groupID(item.Options))
				entry.MessageDeduplicationId = aws.String(p.dedupID(item.Options, i))
			}
			entries = append(entries, entry)
		}

		out, err := p.client.PublishBatch(ctx, &sns.PublishBatchInput{
			TopicArn:                   aws.String(p.cfg.TopicArn),
			PublishBatchRequestEntries: entries,
		})
		if err != nil {
			return nil, core.NewPublishError("failed to publish batch", true, err)
		}

		for _, s := range out.Successful {
			id := aws.ToString(s.MessageId)
			if id == "" {
				id = fmt.Sprintf("sns-batch-%d", time.Now().UnixNano())
			}
			ids = append(ids, id)
		}
		if len(out.Failed) > 0 {
			p.Logger.Warn("some messages failed to publish", map[string]any{"failed": len(out.Failed)})
		}
	}

	p.Logger.Debug("batch published", map[string]any{"count": len(ids), "topicArn": p.cfg.TopicArn})
	return ids, nil
}

// Flush is a no-op; SNS publishes synchronously.
func (p *Producer) Flush(ctx context.Context) error { return nil }

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
		Details:   map[string]any{"topicArn": p.cfg.TopicArn, "fifo": p.cfg.FIFO},
	}, nil
}

// groupID resolves the FIFO message group id: per-message key, then
// PublishOptions.GroupID, then producer default, then "default".
func (p *Producer) groupID(opts *core.PublishOptions) string {
	if opts != nil {
		if opts.Key != "" {
			return opts.Key
		}
		if opts.GroupID != "" {
			return opts.GroupID
		}
	}
	if p.cfg.Producer.MessageGroupID != "" {
		return p.cfg.Producer.MessageGroupID
	}
	return "default"
}

// dedupID resolves the FIFO deduplication id: per-message DeduplicationID, then
// producer default, then a generated unique value.
func (p *Producer) dedupID(opts *core.PublishOptions, index int) string {
	if opts != nil && opts.DeduplicationID != "" {
		return opts.DeduplicationID
	}
	if p.cfg.Producer.MessageDeduplicationID != "" {
		return p.cfg.Producer.MessageDeduplicationID
	}
	return fmt.Sprintf("%d-%d-%d", time.Now().UnixNano(), index, rand.Int63())
}

// toMessageAttributes converts message headers to SNS message attributes. Header
// values are byte slices; they are sent as String attributes.
func toMessageAttributes(headers core.MessageHeaders) map[string]snstypes.MessageAttributeValue {
	attrs := make(map[string]snstypes.MessageAttributeValue, len(headers))
	for k, v := range headers {
		attrs[k] = snstypes.MessageAttributeValue{
			DataType:    aws.String("String"),
			StringValue: aws.String(string(v)),
		}
	}
	return attrs
}

var _ core.Producer = (*Producer)(nil)
