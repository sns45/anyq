//go:build integration

// Integration tests for the Google Cloud Pub/Sub adapter. These run against the
// Pub/Sub emulator and are skipped unless PUBSUB_EMULATOR_HOST is set
// (see apps/testers/google-pubsub/docker-compose.yml).
//
// Run with:
//
//	docker compose -f apps/testers/google-pubsub/docker-compose.yml up -d
//	PUBSUB_EMULATOR_HOST=localhost:8085 go test -tags integration ./pubsub/...
package pubsub

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

const testProjectID = "anyq-local"

func requireEmulator(t *testing.T) {
	t.Helper()
	if os.Getenv("PUBSUB_EMULATOR_HOST") == "" {
		t.Skip("PUBSUB_EMULATOR_HOST not set; skipping Pub/Sub integration test")
	}
}

func uniqueName(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func connConfig() ConnectionConfig {
	return ConnectionConfig{
		ProjectID:    testProjectID,
		APIEndpoint:  os.Getenv("PUBSUB_EMULATOR_HOST"),
		EmulatorMode: true,
	}
}

// TestPublishConsumeAck verifies the happy path: publish a message and consume
// it back, acking on success.
func TestPublishConsumeAck(t *testing.T) {
	requireEmulator(t)

	topic := uniqueName("orders")
	sub := uniqueName("orders-sub")
	autoCreate := true

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	producer := NewProducer(ProducerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "test-producer"},
		Connection:      connConfig(),
		Topic:           TopicConfig{Name: topic, AutoCreate: &autoCreate},
	})
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	consumer := NewConsumer(ConsumerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "test-consumer"},
		Connection:      connConfig(),
		Subscription:    SubscriptionConfig{Name: sub, AutoCreate: &autoCreate},
		TopicName:       topic,
	})
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	payload := []byte(`{"orderId":"ORD-1"}`)
	if _, err := producer.Publish(ctx, payload, &core.PublishOptions{Key: "ORD-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	received := make(chan []byte, 1)
	recvCtx, recvCancel := context.WithCancel(ctx)
	defer recvCancel()
	go func() {
		_ = consumer.Subscribe(recvCtx, func(_ context.Context, m core.Message) error {
			select {
			case received <- m.Body():
			default:
			}
			return nil
		}, nil)
	}()

	select {
	case body := <-received:
		if string(body) != string(payload) {
			t.Fatalf("unexpected body: got %q want %q", body, payload)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for message")
	}
}

// TestRetryThenDeadLetter verifies the retry-strategy E2E: a handler that always
// fails with a non-retryable error is dead-lettered (base default: warn + nack),
// and OnError fires for the non-ack outcome.
func TestRetryThenDeadLetter(t *testing.T) {
	requireEmulator(t)

	topic := uniqueName("dlq-orders")
	sub := uniqueName("dlq-orders-sub")
	autoCreate := true

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	producer := NewProducer(ProducerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "test-producer"},
		Connection:      connConfig(),
		Topic:           TopicConfig{Name: topic, AutoCreate: &autoCreate},
	})
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	var onErrCount int32
	// Non-retryable error so RetryThenDeadLetter dead-letters on the first attempt.
	nonRetryable := func(error) bool { return false }

	consumer := NewConsumer(ConsumerConfig{
		BaseQueueConfig: core.BaseQueueConfig{
			ClientID: "test-consumer",
			Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
				IsRetryable: nonRetryable,
			}),
			OnError: func(error) { atomic.AddInt32(&onErrCount, 1) },
		},
		Connection:   connConfig(),
		Subscription: SubscriptionConfig{Name: sub, AutoCreate: &autoCreate},
		TopicName:    topic,
	})
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	if _, err := producer.Publish(ctx, []byte(`{"orderId":"POISON"}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}

	var (
		mu          sync.Mutex
		handlerHits int
	)
	deadLettered := make(chan struct{}, 1)
	recvCtx, recvCancel := context.WithCancel(ctx)
	defer recvCancel()
	go func() {
		_ = consumer.Subscribe(recvCtx, func(_ context.Context, _ core.Message) error {
			mu.Lock()
			handlerHits++
			mu.Unlock()
			select {
			case deadLettered <- struct{}{}:
			default:
			}
			return errors.New("permanent failure")
		}, nil)
	}()

	select {
	case <-deadLettered:
		// Give ApplyStrategy a moment to route through DeadLetterMessage.
		time.Sleep(500 * time.Millisecond)
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for handler to fail")
	}

	if atomic.LoadInt32(&onErrCount) == 0 {
		t.Fatal("expected OnError to fire for the dead-lettered message")
	}
}
