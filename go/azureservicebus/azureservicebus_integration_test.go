//go:build integration

// Package azureservicebus integration tests run against a live Azure Service Bus
// emulator. They are skipped unless AZURE_SERVICEBUS_CONNECTION_STRING is set.
//
// Bring up the emulator with:
//
//	cd apps/testers/azure-servicebus && docker compose up -d
//
// then run:
//
//	AZURE_SERVICEBUS_CONNECTION_STRING='Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true' \
//	  go test -tags integration ./azureservicebus/...
package azureservicebus

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

func testConfig(t *testing.T, queue string) Config {
	t.Helper()
	connStr := os.Getenv("AZURE_SERVICEBUS_CONNECTION_STRING")
	if connStr == "" {
		t.Skip("AZURE_SERVICEBUS_CONNECTION_STRING not set; skipping integration test")
	}
	return Config{
		BaseQueueConfig:    core.BaseQueueConfig{ClientID: "azure-servicebus-it"},
		Connection:         ConnectionConfig{ConnectionString: connStr},
		Queue:              &QueueConfig{Name: queue},
		MaxConcurrentCalls: 5,
	}
}

// TestPublishConsumeComplete publishes a message, consumes it, and completes it.
func TestPublishConsumeComplete(t *testing.T) {
	cfg := testConfig(t, queueOrDefault())

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	producer := NewProducer(cfg)
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	consumer := NewConsumer(cfg)
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	body := []byte(`{"orderId":"IT-1","hello":"world"}`)
	if _, err := producer.Publish(ctx, body, &core.PublishOptions{Key: "IT-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	received := make(chan []byte, 1)
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, m core.Message) error {
			select {
			case received <- m.Body():
			default:
			}
			return nil
		}, nil)
	}()

	select {
	case got := <-received:
		if string(got) != string(body) {
			t.Fatalf("body mismatch: got %q want %q", got, body)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for message")
	}
}

// TestRetryThenDeadLetter verifies a perpetually-failing handler with the
// RetryThenDeadLetter strategy ends up dead-lettered.
//
// Faithful to the shipped TS adapter, the strategy DeadLetter action uses the
// base hook (nack(false) -> AbandonMessage), so the message is redelivered and
// the broker routes it to its native dead-letter sub-queue once MaxDeliveryCount
// is exceeded. The emulator queue "orders" is configured with MaxDeliveryCount:10.
func TestRetryThenDeadLetter(t *testing.T) {
	cfg := testConfig(t, queueOrDefault())
	cfg.Strategy = core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
		MaxAttempts: 1,
		Backoff:     &core.RetryConfig{InitialDelayMs: 10, MaxDelayMs: 20, Multiplier: 1, Jitter: false},
		IsRetryable: func(error) bool { return true },
	})

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	producer := NewProducer(cfg)
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	consumer := NewConsumer(cfg)
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	body := []byte(`{"orderId":"IT-DLQ"}`)
	if _, err := producer.Publish(ctx, body, &core.PublishOptions{Key: "IT-DLQ"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	failed := make(chan struct{}, 1)
	subCtx, subCancel := context.WithCancel(ctx)
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, _ core.Message) error {
			select {
			case failed <- struct{}{}:
			default:
			}
			return errors.New("permanent handler failure")
		}, nil)
	}()

	select {
	case <-failed:
	case <-time.After(20 * time.Second):
		subCancel()
		t.Fatal("handler was never invoked")
	}
	// Let the handler fail through repeated redeliveries until the broker
	// dead-letters the message (MaxDeliveryCount exceeded). Then stop consuming.
	time.Sleep(20 * time.Second)
	subCancel()

	// Verify the message landed on the dead-letter sub-queue.
	dlqCfg := testConfig(t, queueOrDefault())
	dlqCfg.Receiver.DeadLetterSubQueue = true
	dlqConsumer := NewConsumer(dlqCfg)
	if err := dlqConsumer.Connect(ctx); err != nil {
		t.Fatalf("dlq consumer connect: %v", err)
	}
	defer dlqConsumer.Disconnect(context.Background())

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		recvCtx, recvCancel := context.WithTimeout(ctx, 5*time.Second)
		msgs, err := dlqConsumer.Receiver().ReceiveMessages(recvCtx, 5, nil)
		recvCancel()
		if err != nil {
			t.Fatalf("receive from DLQ: %v", err)
		}
		if len(msgs) > 0 {
			for _, m := range msgs {
				_ = dlqConsumer.Receiver().CompleteMessage(context.Background(), m, nil)
			}
			return
		}
	}
	t.Fatal("expected a dead-lettered message on the dead-letter sub-queue; found none")
}

// TestNativePark verifies that a Park decision is honoured by the broker, not by
// an in-process sleep. Consumer A parks the message (re-send with a future
// scheduled enqueue time + complete the original), then is fully DISCONNECTED.
// A fresh consumer B still receives the message only after the scheduled delay —
// which is impossible if the delay were a goroutine sleeping inside consumer A.
func TestNativePark(t *testing.T) {
	const parkDelay = 8 * time.Second

	cfg := testConfig(t, queueOrDefault())
	// Always park on failure (native, since the ASB consumer supports delay).
	cfg.Strategy = core.Custom("park-always", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
		return core.Park(int(parkDelay.Milliseconds())), nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	producer := NewProducer(cfg)
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	if _, err := producer.Publish(ctx, []byte(`{"orderId":"IT-PARK"}`), &core.PublishOptions{Key: "IT-PARK"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	// Consumer A: receives once, fails (-> native park), then we tear it down.
	consumerA := NewConsumer(cfg)
	if err := consumerA.Connect(ctx); err != nil {
		t.Fatalf("consumer A connect: %v", err)
	}
	firstSeen := make(chan struct{}, 1)
	subCtxA, subCancelA := context.WithCancel(ctx)
	go func() {
		_ = consumerA.Subscribe(subCtxA, func(_ context.Context, _ core.Message) error {
			select {
			case firstSeen <- struct{}{}:
			default:
			}
			return errors.New("force a park")
		}, nil)
	}()

	select {
	case <-firstSeen:
	case <-time.After(20 * time.Second):
		subCancelA()
		_ = consumerA.Disconnect(context.Background())
		t.Fatal("consumer A never received the message")
	}
	parkedAt := time.Now()

	// Grace period so ParkMessage (scheduled re-send + complete original) finishes,
	// then fully disconnect A: no goroutine of A's is left to "redeliver".
	time.Sleep(2 * time.Second)
	subCancelA()
	if err := consumerA.Disconnect(context.Background()); err != nil {
		t.Fatalf("consumer A disconnect: %v", err)
	}

	// Consumer B: a fresh consumer, NO strategy, just records + acks.
	bCfg := testConfig(t, queueOrDefault())
	consumerB := NewConsumer(bCfg)
	if err := consumerB.Connect(ctx); err != nil {
		t.Fatalf("consumer B connect: %v", err)
	}
	defer consumerB.Disconnect(context.Background())

	gotAt := make(chan time.Time, 1)
	subCtxB, subCancelB := context.WithCancel(ctx)
	defer subCancelB()
	go func() {
		_ = consumerB.Subscribe(subCtxB, func(_ context.Context, _ core.Message) error {
			select {
			case gotAt <- time.Now():
			default:
			}
			return nil
		}, nil)
	}()

	select {
	case t2 := <-gotAt:
		elapsed := t2.Sub(parkedAt)
		// Broker-mediated: the message reappears only after (nearly) the full delay,
		// to a consumer that did not exist when the park happened. Allow scheduling
		// slack but require clearly more than the 2s grace, proving it was the
		// broker's scheduled enqueue and not an immediate redelivery.
		if elapsed < parkDelay-2*time.Second {
			t.Fatalf("message reappeared too early (%s < ~%s); park was not broker-mediated", elapsed, parkDelay)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("parked message never reappeared on a fresh consumer")
	}
}

func queueOrDefault() string {
	if q := os.Getenv("AZURE_SERVICEBUS_QUEUE"); q != "" {
		return q
	}
	return "orders"
}
