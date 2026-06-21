package azureservicebus

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"

	"github.com/sns45/anyq/go/core"
)

// Consumer consumes messages from an Azure Service Bus queue or topic subscription.
//
// It supports per-message settlement (complete/abandon/dead-letter) and native
// delayed redelivery: a strategy Park is honoured by re-sending the message with
// a future ScheduledEnqueueTime and completing the original (see ParkMessage).
type Consumer struct {
	*core.BaseConsumer
	cfg      Config
	client   *azservicebus.Client
	receiver *azservicebus.Receiver
	// sender re-sends parked messages with a scheduled enqueue time.
	sender *azservicebus.Sender
	entity string
}

// SupportsNativeDelay reports that Azure Service Bus can natively schedule a
// delayed redelivery via ScheduledEnqueueTime (see ParkMessage).
func (c *Consumer) SupportsNativeDelay() bool { return true }

// NewConsumer builds an Azure Service Bus consumer.
func NewConsumer(cfg Config) *Consumer {
	if cfg.Driver == "" {
		cfg.Driver = core.DriverAzureServiceBus
	}
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)

	c := &Consumer{
		BaseConsumer: bc,
		cfg:          cfg,
		entity:       consumerEntity(cfg),
	}
	bc.Bind(c)
	return c
}

// consumerEntity returns a human-readable entity path for logging/health.
func consumerEntity(cfg Config) string {
	if cfg.Subscription != nil {
		return cfg.Subscription.TopicName + "/" + cfg.Subscription.SubscriptionName
	}
	if cfg.Queue != nil {
		return cfg.Queue.Name
	}
	return ""
}

// Connect creates the Service Bus client and a receiver for the queue/subscription.
func (c *Consumer) Connect(ctx context.Context) error {
	if c.IsConnected() {
		return nil
	}
	// Fail loud (or warn once) if a park-capable strategy would downgrade. Azure
	// supports native delay, so this is a no-op here, but it keeps the startup
	// policy check uniform across adapters.
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	if c.cfg.Queue == nil && c.cfg.Subscription == nil {
		return core.NewConnectionError("azure service bus consumer requires a queue or subscription", nil)
	}
	if c.cfg.Connection.ConnectionString == "" {
		return core.NewConnectionError("azure service bus consumer requires a connection string", nil)
	}

	client, err := azservicebus.NewClientFromConnectionString(c.cfg.Connection.ConnectionString, nil)
	if err != nil {
		return core.NewConnectionError("failed to connect to Azure Service Bus", err)
	}

	opts := &azservicebus.ReceiverOptions{ReceiveMode: c.cfg.receiveMode()}
	if c.cfg.Receiver.DeadLetterSubQueue {
		opts.SubQueue = azservicebus.SubQueueDeadLetter
	}

	var receiver *azservicebus.Receiver
	if c.cfg.Subscription != nil {
		receiver, err = client.NewReceiverForSubscription(
			c.cfg.Subscription.TopicName, c.cfg.Subscription.SubscriptionName, opts)
	} else {
		receiver, err = client.NewReceiverForQueue(c.cfg.Queue.Name, opts)
	}
	if err != nil {
		_ = client.Close(ctx)
		return core.NewConnectionError("failed to create Service Bus receiver", err)
	}

	// A sender on the park entity (topic for a subscription, else the queue) lets
	// ParkMessage re-send with a scheduled enqueue time.
	var sender *azservicebus.Sender
	if entity := c.cfg.parkEntity(); entity != "" {
		sender, err = client.NewSender(entity, nil)
		if err != nil {
			_ = receiver.Close(ctx)
			_ = client.Close(ctx)
			return core.NewConnectionError("failed to create Service Bus sender for park", err)
		}
	}

	c.client = client
	c.receiver = receiver
	c.sender = sender
	c.SetConnected(true)
	c.Logger.Info("Azure Service Bus consumer connected",
		map[string]any{"entity": c.entity, "receiveMode": string(c.cfg.Receiver.ReceiveMode)})
	return nil
}

// Disconnect closes the receiver and client.
func (c *Consumer) Disconnect(ctx context.Context) error {
	if !c.IsConnected() {
		return nil
	}
	if c.sender != nil {
		if err := c.sender.Close(ctx); err != nil {
			c.Logger.Error("error closing sender", map[string]any{"error": err.Error()})
		}
		c.sender = nil
	}
	if c.receiver != nil {
		if err := c.receiver.Close(ctx); err != nil {
			c.Logger.Error("error closing receiver", map[string]any{"error": err.Error()})
		}
		c.receiver = nil
	}
	if c.client != nil {
		if err := c.client.Close(ctx); err != nil {
			c.Logger.Error("error closing client", map[string]any{"error": err.Error()})
		}
		c.client = nil
	}
	c.SetConnected(false)
	c.Logger.Info("Azure Service Bus consumer disconnected", nil)
	return nil
}

// Subscribe receives messages in a loop until ctx is cancelled or a fatal Fail
// decision occurs.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if c.receiver == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	autoAck := opts.AutoAckEnabled()
	maxCalls := c.cfg.maxConcurrentCalls()
	c.Logger.Info("subscribed to messages", map[string]any{"entity": c.entity, "maxConcurrentCalls": maxCalls})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 100*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		sbMessages, err := c.receiver.ReceiveMessages(ctx, maxCalls, nil)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.Logger.Error("error receiving messages", map[string]any{"error": err.Error()})
			if !sleepOrDone(ctx, time.Second) {
				return ctx.Err()
			}
			continue
		}

		for _, sb := range sbMessages {
			if c.IsPaused() {
				// Abandon to release the lock when paused (mirrors TS behaviour).
				_ = c.receiver.AbandonMessage(ctx, sb, nil)
				continue
			}
			msg := c.convertMessage(sb)
			if fatal := c.handleOne(ctx, handler, msg, sb, autoAck); fatal != nil {
				return fatal
			}
		}
	}
}

func (c *Consumer) handleOne(ctx context.Context, handler core.Handler, msg core.Message, sb *azservicebus.ReceivedMessage, autoAck bool) error {
	herr := handler(ctx, msg)
	if herr == nil {
		if autoAck {
			return ackFatal(msg.Ack(ctx))
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

	// Legacy behaviour: abandon the message so the broker redelivers (or routes
	// to its native DLQ once MaxDeliveryCount is hit). Mirrors the TS catch block.
	c.Logger.Error("error processing message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	if err := c.receiver.AbandonMessage(ctx, sb, nil); err != nil {
		c.Logger.Error("failed to abandon message", map[string]any{"messageId": msg.ID(), "error": err.Error()})
	}
	return nil
}

// ackFatal treats a context-cancellation ack error as fatal so the loop stops.
func ackFatal(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// SubscribeBatch receives messages in batches until ctx is cancelled.
func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if c.receiver == nil {
		return core.NewConnectionError("consumer not connected", nil)
	}
	batchSize := 10
	if opts != nil && opts.BatchSize > 0 {
		batchSize = opts.BatchSize
	}
	autoAck := opts.AutoAckEnabled()
	var recvOpts *azservicebus.ReceiveMessagesOptions
	if opts != nil && opts.BatchTimeout > 0 {
		recvOpts = &azservicebus.ReceiveMessagesOptions{TimeAfterFirstMessage: opts.BatchTimeout}
	}
	c.Logger.Info("subscribed to messages (batch mode)", map[string]any{"entity": c.entity, "batchSize": batchSize})

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if !sleepOrDone(ctx, 100*time.Millisecond) {
				return ctx.Err()
			}
			continue
		}

		sbMessages, err := c.receiver.ReceiveMessages(ctx, batchSize, recvOpts)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.Logger.Error("error receiving batch", map[string]any{"error": err.Error()})
			if !sleepOrDone(ctx, time.Second) {
				return ctx.Err()
			}
			continue
		}
		if len(sbMessages) == 0 {
			continue
		}

		msgs := make([]core.Message, len(sbMessages))
		for i, sb := range sbMessages {
			msgs[i] = c.convertMessage(sb)
		}

		herr := handler(ctx, msgs)
		if herr != nil {
			// Only abandon messages the strategy did not settle. ApplyStrategy may
			// have already completed/parked/dead-lettered some (handled==true), so
			// abandoning the whole batch would double-settle those.
			var unhandled []*azservicebus.ReceivedMessage
			for i, m := range msgs {
				mm := m
				reinvoke := func() error { return handler(ctx, []core.Message{mm}) }
				handled, applyErr := c.ApplyStrategy(ctx, mm, herr, reinvoke)
				if applyErr != nil {
					return applyErr
				}
				if !handled {
					unhandled = append(unhandled, sbMessages[i])
				}
			}
			if len(unhandled) > 0 {
				c.Logger.Error("error processing batch", map[string]any{"count": len(unhandled), "error": herr.Error()})
				if c.Config.OnError != nil {
					c.Config.OnError(herr)
				}
				for _, sb := range unhandled {
					_ = c.receiver.AbandonMessage(ctx, sb, nil)
				}
			}
			continue
		}
		if autoAck {
			for _, m := range msgs {
				_ = m.Ack(ctx)
			}
		}
	}
}

// HealthCheck reports consumer health.
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	if c.receiver == nil || !c.IsConnected() {
		return core.HealthStatus{Healthy: false, Connected: false, Error: "Not connected"}, nil
	}
	kind := "queue"
	if c.cfg.Subscription != nil {
		kind = "subscription"
	}
	return core.HealthStatus{
		Healthy:   true,
		Connected: true,
		LatencyMs: time.Since(start).Milliseconds(),
		Details:   map[string]any{"entity": c.entity, "type": kind, "paused": c.IsPaused()},
	}, nil
}

// ParkMessage honours a Park decision natively: it re-sends the message body to
// the park entity with ScheduledEnqueueTime = now + delayMs, then completes the
// original so the broker won't redeliver it after the lock. This is the SQS park
// pattern (re-send-with-delay then settle original) adapted to Azure Service Bus.
//
// The re-send + complete use a context detached from the (possibly cancelling)
// subscribe loop but bounded by a timeout, so a park in flight during shutdown
// still finalizes rather than leaving the message locked.
func (c *Consumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	sb, ok := msg.Raw().(*azservicebus.ReceivedMessage)
	if c.sender == nil || c.receiver == nil || !ok {
		c.Logger.Warn("cannot park natively (no sender/receiver/raw message); abandoning for redelivery",
			map[string]any{"messageId": msg.ID()})
		return msg.Nack(ctx, true)
	}

	dctx, cancel := disposeContext(ctx)
	defer cancel()

	enqueueAt := time.Now().Add(time.Duration(delayMs) * time.Millisecond)
	out := &azservicebus.Message{
		Body:                 sb.Body,
		ContentType:          sb.ContentType,
		ScheduledEnqueueTime: &enqueueAt,
	}
	if sb.PartitionKey != nil {
		out.PartitionKey = sb.PartitionKey
	}
	if sb.SessionID != nil {
		out.SessionID = sb.SessionID
	}
	if sb.CorrelationID != nil {
		out.CorrelationID = sb.CorrelationID
	}
	if len(sb.ApplicationProperties) > 0 {
		out.ApplicationProperties = sb.ApplicationProperties
	}

	if err := c.sender.SendMessage(dctx, out, nil); err != nil {
		c.Logger.Error("failed to schedule parked message; abandoning for redelivery",
			map[string]any{"messageId": msg.ID(), "error": err.Error()})
		return msg.Nack(ctx, true)
	}
	if err := c.receiver.CompleteMessage(dctx, sb, nil); err != nil {
		c.Logger.Error("parked message scheduled but failed to complete original",
			map[string]any{"messageId": msg.ID(), "error": err.Error()})
		return err
	}
	c.Logger.Debug("message parked via scheduled re-send",
		map[string]any{"messageId": msg.ID(), "delayMs": delayMs})
	return nil
}

// disposeContext returns a context for a terminal disposition (park re-send +
// complete) that is detached from the subscribe context but bounded by a timeout,
// so finalizing a message succeeds even during shutdown.
func disposeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
}

// DeadLetterNative routes a message to the broker's native dead-letter sub-queue.
//
// This is intentionally NOT the ConsumerHooks.DeadLetterMessage hook: the shipped
// TS adapter does not override deadLetterMessage, so the strategy DeadLetter
// action uses the base hook (warn + nack(false)). To match that behaviour we
// leave the hook on the embedded *core.BaseConsumer and expose native DLQ routing
// here as an explicit escape hatch (used by the legacy path / E2E tests).
func (c *Consumer) DeadLetterNative(ctx context.Context, msg core.Message, reason string) error {
	sb, ok := msg.Raw().(*azservicebus.ReceivedMessage)
	if c.receiver == nil || !ok {
		return core.NewConsumeError("cannot dead-letter: no native receiver/message", nil)
	}
	r := reason
	if err := c.receiver.DeadLetterMessage(ctx, sb, &azservicebus.DeadLetterOptions{Reason: &r}); err != nil {
		c.Logger.Error("failed to dead-letter message", map[string]any{"messageId": msg.ID(), "error": err.Error()})
		return err
	}
	c.Logger.Warn("message dead-lettered", map[string]any{"messageId": msg.ID(), "reason": reason})
	return nil
}

// Receiver returns the underlying receiver (for testing).
func (c *Consumer) Receiver() *azservicebus.Receiver { return c.receiver }

// convertMessage maps an SDK ReceivedMessage to a core.Message.
func (c *Consumer) convertMessage(sb *azservicebus.ReceivedMessage) core.Message {
	headers := core.MessageHeaders{}
	for k, v := range sb.ApplicationProperties {
		headers[k] = []byte(toString(v))
	}

	id := sb.MessageID
	if id == "" {
		id = core.GenerateMessageID()
	}

	timestamp := time.Now()
	if sb.EnqueuedTime != nil {
		timestamp = *sb.EnqueuedTime
	}

	deliveryAttempt := int(sb.DeliveryCount)
	if deliveryAttempt < 1 {
		deliveryAttempt = 1
	}

	meta := &core.AzureServiceBusMetadata{}
	if sb.SequenceNumber != nil {
		meta.SequenceNumber = *sb.SequenceNumber
	}
	if sb.EnqueuedTime != nil {
		meta.EnqueuedTime = *sb.EnqueuedTime
	}
	if sb.LockedUntil != nil {
		meta.LockedUntil = *sb.LockedUntil
	}
	if sb.SessionID != nil {
		meta.SessionID = *sb.SessionID
	}
	key := ""
	if sb.PartitionKey != nil {
		key = *sb.PartitionKey
		meta.PartitionKey = key
	}

	return core.NewMessage(core.MessageParams{
		ID:              id,
		Body:            sb.Body,
		Key:             key,
		Headers:         headers,
		Timestamp:       timestamp,
		DeliveryAttempt: deliveryAttempt,
		Metadata: core.ProviderMetadata{
			Provider:        core.DriverAzureServiceBus,
			AzureServiceBus: meta,
		},
		Raw: sb,
		OnAck: func(ctx context.Context) error {
			if c.receiver == nil {
				return nil
			}
			err := c.receiver.CompleteMessage(ctx, sb, nil)
			if err == nil {
				c.Logger.Debug("message completed", map[string]any{"messageId": id})
			}
			return err
		},
		OnNack: func(ctx context.Context, _ bool) error {
			if c.receiver == nil {
				return nil
			}
			err := c.receiver.AbandonMessage(ctx, sb, nil)
			if err == nil {
				c.Logger.Debug("message abandoned", map[string]any{"messageId": id})
			}
			return err
		},
		OnExtendDeadline: func(ctx context.Context, _ time.Duration) error {
			if c.receiver == nil {
				return nil
			}
			return c.receiver.RenewMessageLock(ctx, sb, nil)
		},
	})
}

// toString renders an application-property value as a string (mirrors the TS
// conversion of applicationProperties to header strings).
func toString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// sleepOrDone sleeps for d, returning false if ctx is cancelled first.
func sleepOrDone(ctx context.Context, d time.Duration) bool {
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
