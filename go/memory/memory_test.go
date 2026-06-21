package memory_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

func waitFor(t *testing.T, cond func() bool, timeout time.Duration, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", msg)
}

func TestMemoryPublishConsumeAck(t *testing.T) {
	memory.ClearAllQueues()
	cfg := memory.Config{QueueName: "orders-ack"}

	producer := memory.NewProducer(cfg)
	consumer := memory.NewConsumer(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := producer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := consumer.Connect(ctx); err != nil {
		t.Fatal(err)
	}

	var (
		mu       sync.Mutex
		received [][]byte
	)
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, m core.Message) error {
			mu.Lock()
			received = append(received, m.Body())
			mu.Unlock()
			return nil
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"id":1}`), nil); err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(received) == 1
	}, 2*time.Second, "message consumed")

	// After ack, nothing should remain queued or in-flight.
	waitFor(t, func() bool {
		return consumer.Queue().Size() == 0 && consumer.Queue().ProcessingCount() == 0
	}, 2*time.Second, "message acked (queue drained)")
}

func TestMemoryRetryStrategyToDLQ(t *testing.T) {
	memory.ClearAllQueues()
	// maxAttempts = MaxRetries+1 = 3; handler always fails with a retryable error.
	cfg := memory.Config{
		QueueName: "orders-retry",
		BaseQueueConfig: core.BaseQueueConfig{
			Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
				Backoff: &core.RetryConfig{InitialDelayMs: 1, MaxDelayMs: 2, Multiplier: 1, Jitter: false},
			}),
			Retry: &core.RetryConfig{MaxRetries: 2},
			DeadLetterQueue: &core.DeadLetterConfig{
				Enabled:             true,
				Destination:         "orders-retry-dlq",
				MaxDeliveryAttempts: 3,
			},
		},
	}

	producer := memory.NewProducer(cfg)
	consumer := memory.NewConsumer(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := producer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := consumer.Connect(ctx); err != nil {
		t.Fatal(err)
	}

	var calls int32
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, _ core.Message) error {
			atomic.AddInt32(&calls, 1)
			return core.NewConsumeError("downstream temporarily unavailable", nil)
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"id":2}`), nil); err != nil {
		t.Fatal(err)
	}

	dlq := consumer.DLQ()
	if dlq == nil {
		t.Fatal("expected DLQ to be configured")
	}

	waitFor(t, func() bool { return dlq.Size() == 1 }, 3*time.Second, "message landed in DLQ after retries")

	// Handler was invoked maxAttempts times (initial + in-process retries).
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("handler calls = %d, want 3 (1 initial + 2 in-process retries)", got)
	}

	// Verify death headers were attached on the dead-lettered message.
	stored := dlq.Dequeue()
	if stored == nil {
		t.Fatal("expected a message in the DLQ")
	}
	if string(stored.Headers["x-death-reason"]) != "max attempts exceeded" {
		t.Fatalf("x-death-reason = %q, want %q", stored.Headers["x-death-reason"], "max attempts exceeded")
	}
	if string(stored.Headers["x-original-queue"]) != "orders-retry" {
		t.Fatalf("x-original-queue = %q", stored.Headers["x-original-queue"])
	}
}

func TestMemoryNativeParkRedelivers(t *testing.T) {
	memory.ClearAllQueues()
	var attempts int32
	cfg := memory.Config{
		QueueName: "orders-park",
		BaseQueueConfig: core.BaseQueueConfig{
			// Park on the first failure; succeed on redelivery.
			Strategy: core.Custom("park-once", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
				return core.Park(10), nil
			}),
		},
	}

	producer := memory.NewProducer(cfg)
	consumer := memory.NewConsumer(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = producer.Connect(ctx)
	_ = consumer.Connect(ctx)

	var succeeded int32
	go func() {
		_ = consumer.Subscribe(ctx, func(_ context.Context, _ core.Message) error {
			n := atomic.AddInt32(&attempts, 1)
			if n == 1 {
				return core.NewConsumeError("first attempt fails -> park", nil)
			}
			atomic.AddInt32(&succeeded, 1)
			return nil
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"id":3}`), nil); err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool { return atomic.LoadInt32(&succeeded) == 1 }, 3*time.Second,
		"parked message redelivered and processed")
}
