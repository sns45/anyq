//go:build integration

// Integration tests for the NATS JetStream adapter. They require a running NATS
// server with JetStream enabled; set NATS_URL (e.g. nats://localhost:4222) to
// run them, otherwise they are skipped.
//
//	docker compose -f apps/testers/nats/docker-compose.yml up -d
//	NATS_URL=nats://localhost:4222 go test -tags integration ./nats/...
package nats

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

func testConfig(t *testing.T, suffix string) Config {
	t.Helper()
	url := os.Getenv("NATS_URL")
	if url == "" {
		t.Skip("NATS_URL not set; skipping NATS integration test")
	}
	unique := fmt.Sprintf("%s-%d", suffix, time.Now().UnixNano())
	stream := "TEST_" + strings.ToUpper(strings.ReplaceAll(unique, "-", "_"))
	subject := "test." + unique
	return Config{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "nats-itest"},
		Connection:      ConnectionConfig{Servers: strings.Split(url, ",")},
		JetStream:       JetStreamConfig{Stream: stream, Subjects: []string{subject}},
		Subject:         subject,
		Consumer:        ConsumerOptions{DurableName: "itest-" + unique},
	}
}

func TestPublishConsumeAck(t *testing.T) {
	cfg := testConfig(t, "ack")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	producer := NewProducer(cfg)
	consumer := NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	got := make(chan []byte, 1)
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, m core.Message) error {
			select {
			case got <- m.Body():
			default:
			}
			return nil
		}, nil)
	}()

	want := []byte(`{"orderId":"O-1","customerId":"C-1"}`)
	if _, err := producer.Publish(ctx, want, &core.PublishOptions{Key: cfg.Subject}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case body := <-got:
		if string(body) != string(want) {
			t.Fatalf("body mismatch: got %q want %q", body, want)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for message")
	}
}

func TestRetryThenDeadLetter(t *testing.T) {
	cfg := testConfig(t, "dlq")
	// Fail every delivery; with RetryThenDeadLetter and a low max-attempts the
	// message should be dead-lettered (default DeadLetterMessage nacks(false)).
	cfg.Strategy = core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
		MaxAttempts: 2,
		Backoff:     &core.RetryConfig{MaxRetries: 1, InitialDelayMs: 10, MaxDelayMs: 20, Multiplier: 2},
		IsRetryable: func(error) bool { return true },
	})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	producer := NewProducer(cfg)
	consumer := NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())
	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())

	var mu sync.Mutex
	deadLettered := make(chan struct{}, 1)

	calls := 0
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, _ core.Message) error {
			mu.Lock()
			calls++
			n := calls
			mu.Unlock()
			// After exhausting attempts the message is dead-lettered (nack(false)
			// terminates it), so handler stops being re-invoked.
			if n >= 2 {
				select {
				case deadLettered <- struct{}{}:
				default:
				}
			}
			return fmt.Errorf("permanent handler failure")
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"orderId":"O-DLQ"}`), &core.PublishOptions{Key: cfg.Subject}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case <-deadLettered:
		// Reached the dead-letter path after retries exhausted.
	case <-ctx.Done():
		t.Fatalf("timed out; handler called %d times, expected dead-letter after retries", calls)
	}
}
