//go:build integration

// Package kafka integration tests run against a live broker. They are skipped
// unless KAFKA_BROKERS is set (e.g. KAFKA_BROKERS=localhost:9092). Start a
// broker with the docker-compose.yml under apps/testers/kafka.
//
// Run: KAFKA_BROKERS=localhost:9092 go test -tags integration ./kafka/...
package kafka

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

func brokersFromEnv(t *testing.T) []string {
	t.Helper()
	v := os.Getenv("KAFKA_BROKERS")
	if v == "" {
		t.Skip("KAFKA_BROKERS not set; skipping Kafka integration test")
	}
	return strings.Split(v, ",")
}

func uniqueTopic(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

// TestPublishConsumeCommit publishes a message, consumes it via a consumer
// group, and verifies the handler observes it (offset committed on ack).
func TestPublishConsumeCommit(t *testing.T) {
	brokers := brokersFromEnv(t)
	topic := uniqueTopic("anyq-it-basic")
	group := uniqueTopic("anyq-it-group")

	cfg := Config{
		Brokers: brokers,
		Topic:   topic,
		ConsumerGroup: &ConsumerGroupOptions{
			GroupID:       group,
			FromBeginning: true,
		},
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "kafka-it"},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := EnsureTopic(ctx, cfg); err != nil {
		t.Fatalf("ensure topic: %v", err)
	}

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

	got := make(chan core.Message, 1)
	var once sync.Once
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, m core.Message) error {
			once.Do(func() { got <- m })
			return nil
		}, nil)
	}()

	// Give the group time to join before producing.
	time.Sleep(3 * time.Second)

	payload := []byte(`{"orderId":"IT-1"}`)
	if _, err := producer.Publish(ctx, payload, &core.PublishOptions{Key: "IT-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case m := <-got:
		if string(m.Body()) != string(payload) {
			t.Fatalf("body mismatch: got %q want %q", m.Body(), payload)
		}
		if m.Metadata().Kafka == nil || m.Metadata().Kafka.Topic != topic {
			t.Fatalf("missing/incorrect kafka metadata: %+v", m.Metadata().Kafka)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for message")
	}
}

// TestRetryThenDeadLetter verifies that a perpetually-failing handler under the
// RetryThenDeadLetter strategy retries in-process then dead-letters (downgraded
// path since Kafka SupportsNativeDelay()==false), and the consume loop advances.
func TestRetryThenDeadLetter(t *testing.T) {
	brokers := brokersFromEnv(t)
	topic := uniqueTopic("anyq-it-retry")
	group := uniqueTopic("anyq-it-retry-group")

	var attempts int32
	deadLettered := make(chan struct{}, 1)

	cfg := Config{
		Brokers: brokers,
		Topic:   topic,
		ConsumerGroup: &ConsumerGroupOptions{
			GroupID:       group,
			FromBeginning: true,
		},
		BaseQueueConfig: core.BaseQueueConfig{
			ClientID: "kafka-it-retry",
			// Resolve max attempts to 3 so the strategy gives up quickly.
			DeadLetterQueue: &core.DeadLetterConfig{MaxDeliveryAttempts: 3},
			Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
				MaxAttempts: 3,
				Backoff:     &core.RetryConfig{MaxRetries: 3, InitialDelayMs: 10, MaxDelayMs: 50, Multiplier: 2},
				IsRetryable: func(error) bool { return true },
			}),
			OnError: func(error) {
				select {
				case deadLettered <- struct{}{}:
				default:
				}
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := EnsureTopic(ctx, cfg); err != nil {
		t.Fatalf("ensure topic: %v", err)
	}

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

	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, _ core.Message) error {
			atomic.AddInt32(&attempts, 1)
			return fmt.Errorf("permanent failure")
		}, nil)
	}()

	time.Sleep(3 * time.Second)

	if _, err := producer.Publish(ctx, []byte(`{"orderId":"FAIL-1"}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case <-deadLettered:
		// Strategy ran (a non-ack outcome emitted at least one error). Note this
		// fires on the FIRST retry decision too, before the in-process reinvokes
		// complete, so we still need to wait for the retry loop below.
	case <-ctx.Done():
		t.Fatal("timed out waiting for dead-letter/strategy outcome")
	}

	// The handler should be invoked multiple times (initial + in-process retries).
	// Poll until the retry loop has run, since it sleeps between attempts.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&attempts) >= 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if n := atomic.LoadInt32(&attempts); n < 2 {
		t.Fatalf("expected multiple handler attempts (retries), got %d", n)
	}
}
