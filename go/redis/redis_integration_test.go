//go:build integration

// Package redis integration tests. These require a live Redis reachable via the
// REDIS_ADDR env var (host:port). They are skipped automatically when REDIS_ADDR
// is unset. Run with: REDIS_ADDR=localhost:6379 go test -tags integration ./redis/...
package redis

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

// testConfig builds a Config pointing at REDIS_ADDR with a unique stream name so
// concurrent test runs don't collide.
func testConfig(t *testing.T, stream string) (Config, bool) {
	t.Helper()
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		t.Skip("REDIS_ADDR not set; skipping Redis integration test")
		return Config{}, false
	}
	host, port := "localhost", 6379
	if i := strings.LastIndexByte(addr, ':'); i >= 0 {
		host = addr[:i]
		if n, err := strconv.Atoi(addr[i+1:]); err == nil {
			port = n
		}
	}
	unique := stream + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	cfg := Config{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "redis-it"},
		Redis:           RedisConnectionConfig{Host: host, Port: port},
		StreamName:      unique,
		ConsumerGroup: ConsumerGroupConfig{
			GroupName:    "it-group",
			ConsumerName: "it-consumer",
			StartID:      "0",
		},
		// Disable auto-claim so the test's pending interaction is deterministic.
		ClaimTimeoutMs: -1,
		BlockTimeoutMs: 200,
	}
	return cfg, true
}

// TestPublishConsumeAck publishes a message and asserts it is consumed and acked.
func TestPublishConsumeAck(t *testing.T) {
	cfg, ok := testConfig(t, "e2e")
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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

	body, _ := json.Marshal(map[string]string{"orderId": "ORD-1"})

	received := make(chan core.Message, 1)
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, m core.Message) error {
			received <- m
			return nil
		}, nil)
	}()

	id, err := producer.Publish(ctx, body, &core.PublishOptions{Key: "ORD-1"})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty entry id")
	}

	select {
	case m := <-received:
		if string(m.Body()) != string(body) {
			t.Fatalf("body mismatch: got %q want %q", m.Body(), body)
		}
		if m.Key() != "ORD-1" {
			t.Fatalf("key mismatch: got %q", m.Key())
		}
		if m.Metadata().RedisStreams == nil || m.Metadata().RedisStreams.EntryID != m.ID() {
			t.Fatal("expected RedisStreams metadata with matching entry id")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for message")
	}

	// Allow the auto-ack to land, then assert no pending entries remain.
	time.Sleep(500 * time.Millisecond)
	subCancel()
	groups, err := consumer.Client().XInfoGroups(ctx, consumer.streamName).Result()
	if err != nil {
		t.Fatalf("xinfo groups: %v", err)
	}
	for _, g := range groups {
		if g.Name == consumer.groupName && g.Pending != 0 {
			t.Fatalf("expected 0 pending after ack, got %d", g.Pending)
		}
	}
}

// TestRetryThenDeadLetter fails the handler N times with a retryable error using
// the RetryThenDeadLetter strategy; the message should end up dead-lettered
// (acked off the pending list via the base nack(false) default).
func TestRetryThenDeadLetter(t *testing.T) {
	cfg, ok := testConfig(t, "dlq")
	if !ok {
		return
	}
	// Strategy: retry up to 3 attempts then dead-letter. Resolve maxAttempts via
	// retry config so the in-process retry cap matches.
	cfg.Strategy = core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
		MaxAttempts: 3,
		Backoff:     &core.RetryConfig{InitialDelayMs: 1, MaxDelayMs: 5, Multiplier: 1, Jitter: false},
	})
	cfg.Retry = &core.RetryConfig{MaxRetries: 2} // maxAttempts = 3

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

	var attempts int32
	done := make(chan struct{})

	body, _ := json.Marshal(map[string]string{"orderId": "ORD-FAIL"})

	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, _ core.Message) error {
			atomic.AddInt32(&attempts, 1)
			// Always retryable failure; strategy exhausts attempts then DLQs.
			return core.NewConsumeError("transient downstream failure", nil)
		}, nil)
	}()

	if _, err := producer.Publish(ctx, body, &core.PublishOptions{Key: "ORD-FAIL"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	// Wait until the entry is dead-lettered: the base DeadLetterMessage default
	// nacks(false), which XACKs the entry, so pending should drop to 0 after the
	// retries are exhausted.
	deadline := time.After(15 * time.Second)
	go func() {
		for {
			groups, err := consumer.Client().XInfoGroups(ctx, consumer.streamName).Result()
			if err == nil {
				pending := int64(-1)
				for _, g := range groups {
					if g.Name == consumer.groupName {
						pending = g.Pending
					}
				}
				if pending == 0 && atomic.LoadInt32(&attempts) >= 3 {
					close(done)
					return
				}
			}
			time.Sleep(200 * time.Millisecond)
		}
	}()

	select {
	case <-done:
		if got := atomic.LoadInt32(&attempts); got < 3 {
			t.Fatalf("expected >= 3 handler attempts before dead-letter, got %d", got)
		}
	case <-deadline:
		t.Fatalf("timed out; attempts=%d (expected dead-letter after retries)", atomic.LoadInt32(&attempts))
	}
}
