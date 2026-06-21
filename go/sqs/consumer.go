package sqs

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from an AWS SQS queue using long polling. It
// supports native delayed redelivery (Park) via SendMessage DelaySeconds; it
// does not override DeadLetterMessage, so the base default (warn + nack(false))
// applies, deleting/abandoning the message so the queue redrive policy /
// visibility timeout governs dead-lettering.
type Consumer struct {
	*core.BaseConsumer
	cfg    Config
	client *sqs.Client
}

// NewConsumer builds an SQS consumer.
func NewConsumer(cfg Config) *Consumer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverSQS
	}
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)

	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	bc.Bind(c)
	return c
}

// SupportsNativeDelay: SQS schedules delayed delivery via SendMessage DelaySeconds.
func (c *Consumer) SupportsNativeDelay() bool { return true }

// ParkMessage re-publishes the body to the same queue with DelaySeconds, then
// deletes the in-flight copy (ack). On failure it nacks with requeue. Mirrors
// the TS parkMessage override.
func (c *Consumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	if c.client == nil {
		c.Logger.Warn("parkMessage called without a connected SQS client", map[string]any{"messageId": msg.ID()})
		return msg.Nack(ctx, false)
	}

	delaySeconds := int32(math.Min(900, math.Max(0, math.Ceil(float64(delayMs)/1000))))

	_, err := c.client.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:     aws.String(c.cfg.QueueURL),
		MessageBody:  aws.String(string(msg.Body())),
		DelaySeconds: delaySeconds,
	})
	if err != nil {
		c.Logger.Error("Failed to park SQS message; returning to queue", map[string]any{
			"messageId": msg.ID(), "error": err.Error(),
		})
		return msg.Nack(ctx, true)
	}
	// Delete the original in-flight copy so SQS doesn't redeliver it after the
	// visibility timeout.
	if ackErr := msg.Ack(ctx); ackErr != nil {
		c.Logger.Error("Failed to delete in-flight copy after parking", map[string]any{
			"messageId": msg.ID(), "error": ackErr.Error(),
		})
		return ackErr
	}
	c.Logger.Debug("message parked for redelivery", map[string]any{"messageId": msg.ID(), "delayMs": delayMs})
	return nil
}

// Connect builds the SQS client.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	client, err := buildClient(ctx, c.cfg.SQS, c.cfg.region())
	if err != nil {
		return core.NewConnectionError("failed to connect to SQS", err)
	}
	c.client = client
	c.SetConnected(true)
	c.Logger.Info("SQS consumer connected", map[string]any{
		"queueUrl": c.cfg.QueueURL, "region": c.cfg.region(),
	})
	return nil
}

// Disconnect releases the SQS client.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	c.client = nil
	c.SetConnected(false)
	c.Logger.Info("SQS consumer disconnected", nil)
	return nil
}

// Subscribe long-polls for messages and dispatches them to handler until ctx is
// cancelled or a fatal (Fail) decision occurs.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.client == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	maxMsgs := c.cfg.maxNumberOfMessages()
	if opts != nil && opts.Concurrency > 0 {
		maxMsgs = clampReceiveCount(int32(opts.Concurrency))
	}
	c.Logger.Info("subscribed to queue", map[string]any{"queueUrl": c.cfg.QueueURL})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, time.Duration(c.cfg.pollingIntervalMs())*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		out, err := c.receive(ctx, maxMsgs)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.Logger.Error("Error polling messages", map[string]any{"error": err.Error()})
			if !sleepOrDone(ctx, time.Duration(c.cfg.pollingIntervalMs())*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		for _, sqsMsg := range out.Messages {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if c.IsPaused() {
				break
			}
			msg := c.wrap(sqsMsg)
			if err := c.handleOne(ctx, handler, msg, autoAck); err != nil {
				return err
			}
		}
	}
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, msg core.Message, autoAck bool) error {
	herr := handler(ctx, msg)
	if herr == nil {
		if autoAck {
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

	// Legacy behaviour (no strategy configured): log + emit, leave the message
	// for SQS to redeliver after the visibility timeout.
	c.Logger.Error("Error processing message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	return nil
}

// SubscribeBatch long-polls for message batches and dispatches them to handler.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.client == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	batchSize := c.cfg.maxNumberOfMessages()
	if opts != nil && opts.BatchSize > 0 {
		batchSize = clampReceiveCount(int32(opts.BatchSize))
	}
	c.Logger.Info("subscribed to queue (batch)", map[string]any{"queueUrl": c.cfg.QueueURL})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, time.Duration(c.cfg.pollingIntervalMs())*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		out, err := c.receive(ctx, batchSize)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.Logger.Error("Error polling batch", map[string]any{"error": err.Error()})
			if !sleepOrDone(ctx, time.Duration(c.cfg.pollingIntervalMs())*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}
		if len(out.Messages) == 0 {
			continue
		}

		msgs := make([]core.Message, len(out.Messages))
		for i, sqsMsg := range out.Messages {
			msgs[i] = c.wrap(sqsMsg)
		}

		herr := handler(ctx, msgs)
		if herr == nil {
			if autoAck {
				for _, m := range msgs {
					_ = m.Ack(ctx)
				}
			}
			continue
		}

		// SQS supports per-message ack; apply strategy per message.
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
			c.Logger.Error("Error processing batch", map[string]any{"count": len(msgs), "error": herr.Error()})
			if c.Config.OnError != nil {
				c.Config.OnError(herr)
			}
		}
	}
}

func (c *Consumer) receive(ctx context.Context, maxMsgs int32) (*sqs.ReceiveMessageOutput, error) {
	return c.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:              aws.String(c.cfg.QueueURL),
		MaxNumberOfMessages:   maxMsgs,
		WaitTimeSeconds:       c.cfg.waitTimeSeconds(),
		VisibilityTimeout:     c.cfg.visibilityTimeout(),
		MessageAttributeNames: []string{"All"},
		MessageSystemAttributeNames: []types.MessageSystemAttributeName{
			types.MessageSystemAttributeNameAll,
		},
	})
}

// HealthCheck reports consumer health.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if c.client == nil || !c.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"queueUrl": c.cfg.QueueURL, "paused": c.IsPaused()},
	}, nil
}

// Client returns the underlying SQS client (for testing).
func (c *Consumer) Client() *sqs.Client { return c.client }

// wrap converts an SQS message into a core.Message with ack/nack callbacks.
func (c *Consumer) wrap(sqsMsg types.Message) core.Message {
	receiptHandle := aws.ToString(sqsMsg.ReceiptHandle)
	messageId := aws.ToString(sqsMsg.MessageId)
	if messageId == "" {
		messageId = fmt.Sprintf("sqs-%d", time.Now().UnixMilli())
	}

	headers := core.MessageHeaders{}
	for k, attr := range sqsMsg.MessageAttributes {
		headers[k] = []byte(aws.ToString(attr.StringValue))
	}

	receiveCount := parseIntAttr(sqsMsg.Attributes, "ApproximateReceiveCount", 1)
	sentTimestamp := parseTimeAttr(sqsMsg.Attributes, "SentTimestamp")
	firstReceive := parseTimeAttr(sqsMsg.Attributes, "ApproximateFirstReceiveTimestamp")

	meta := core.SQSMetadata{
		QueueURL:                         c.cfg.QueueURL,
		ReceiptHandle:                    receiptHandle,
		ApproximateReceiveCount:          receiveCount,
		SentTimestamp:                    sentTimestamp,
		ApproximateFirstReceiveTimestamp: firstReceive,
		MessageGroupID:                   sqsMsg.Attributes["MessageGroupId"],
		SequenceNumber:                   sqsMsg.Attributes["SequenceNumber"],
	}

	ts := sentTimestamp
	if ts.IsZero() {
		ts = time.Now()
	}

	return core.NewMessage(core.MessageParams{
		ID:              messageId,
		Body:            []byte(aws.ToString(sqsMsg.Body)),
		Headers:         headers,
		Timestamp:       ts,
		DeliveryAttempt: receiveCount,
		Metadata: core.ProviderMetadata{
			Provider: core.DriverSQS,
			SQS:      &meta,
		},
		Raw: sqsMsg,
		OnAck: func(ctx context.Context) error {
			if receiptHandle == "" || c.client == nil {
				return nil
			}
			// A terminal disposition must survive cancellation of the subscribe
			// loop, otherwise a successfully-handled message is left undeleted
			// during shutdown and gets redelivered.
			dctx, cancel := disposeContext(ctx)
			defer cancel()
			_, err := c.client.DeleteMessage(dctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(c.cfg.QueueURL),
				ReceiptHandle: aws.String(receiptHandle),
			})
			c.Logger.Debug("message acknowledged", map[string]any{"messageId": messageId})
			return err
		},
		OnNack: func(ctx context.Context, requeue bool) error {
			if receiptHandle == "" || c.client == nil {
				return nil
			}
			dctx, cancel := disposeContext(ctx)
			defer cancel()
			if requeue {
				// Make the message immediately visible again for redelivery.
				_, err := c.client.ChangeMessageVisibility(dctx, &sqs.ChangeMessageVisibilityInput{
					QueueUrl:          aws.String(c.cfg.QueueURL),
					ReceiptHandle:     aws.String(receiptHandle),
					VisibilityTimeout: 0,
				})
				c.Logger.Debug("message nacked", map[string]any{"messageId": messageId, "requeue": true})
				return err
			}
			// Delete the message (it may then go to a DLQ via redrive policy).
			_, err := c.client.DeleteMessage(dctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(c.cfg.QueueURL),
				ReceiptHandle: aws.String(receiptHandle),
			})
			c.Logger.Debug("message nacked", map[string]any{"messageId": messageId, "requeue": false})
			return err
		},
	})
}

// disposeContext returns a context for a terminal ack/nack disposition that is
// detached from the (possibly cancelled) subscribe context but still bounded by
// a timeout, so finalizing an already-processed message succeeds during shutdown.
func disposeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
}

// clampReceiveCount clamps a receive count to the SQS valid range 1-10.
func clampReceiveCount(n int32) int32 {
	if n < 1 {
		return 1
	}
	if n > 10 {
		return 10
	}
	return n
}

func parseIntAttr(attrs map[string]string, key string, def int) int {
	if v, ok := attrs[key]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func parseTimeAttr(attrs map[string]string, key string) time.Time {
	if v, ok := attrs[key]; ok {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
			return time.UnixMilli(ms)
		}
	}
	return time.Time{}
}

// sleepOrDone sleeps for d, returning false if ctx is cancelled first.
func sleepOrDone(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

var _ core.Consumer = (*Consumer)(nil)
var _ core.ConsumerHooks = (*Consumer)(nil)
