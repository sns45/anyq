//go:build integration

// Package rabbitmq integration tests exercise a live RabbitMQ broker. They are
// skipped unless RABBITMQ_URL is set (see docker-compose.yml for a local broker:
// RABBITMQ_URL=amqp://guest:guest@localhost:5672/ go test -tags integration ./rabbitmq/...).
package rabbitmq

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

func testURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("RABBITMQ_URL")
	if url == "" {
		t.Skip("RABBITMQ_URL not set; skipping RabbitMQ integration test")
	}
	return url
}

func uniqueSuffix() string {
	return time.Now().Format("150405.000000")
}

// TestPublishConsumeAck verifies a published message is consumed and acked.
func TestPublishConsumeAck(t *testing.T) {
	url := testURL(t)
	suffix := uniqueSuffix()
	exchange := "anyq-test-ex-" + suffix
	queue := "anyq-test-q-" + suffix
	routingKey := "rk-" + suffix

	conn := ConnectionConfig{URL: url}
	exCfg := ExchangeConfig{Name: exchange, Type: "direct", Durable: false, AutoDelete: true}

	producer := NewProducer(ProducerConfig{
		Connection:  conn,
		Exchange:    exCfg,
		RoutingKey:  routingKey,
		ConfirmMode: true,
	})
	consumer := NewConsumer(ConsumerConfig{
		Connection: conn,
		Queue:      QueueConfig{Name: queue, Durable: false, AutoDelete: true},
		Exchange:   &exCfg,
		BindingKey: routingKey,
		Consumer:   ConsumerOptions{Prefetch: 1},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := consumer.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	received := make(chan core.Message, 1)
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, m core.Message) error {
			received <- m
			return nil
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"hello":"world"}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case m := <-received:
		if string(m.Body()) != `{"hello":"world"}` {
			t.Fatalf("unexpected body: %s", m.Body())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for message")
	}
}

// TestRetryThenDeadLetter verifies that a perpetually-failing handler with the
// RetryThenDeadLetter strategy dead-letters the message. The main queue is
// configured with a dead-letter exchange so the base nack(false) routes the
// message to a DLQ, which we then drain and assert on.
func TestRetryThenDeadLetter(t *testing.T) {
	url := testURL(t)
	suffix := uniqueSuffix()
	exchange := "anyq-dlx-ex-" + suffix
	queue := "anyq-dlx-q-" + suffix
	routingKey := "rk-" + suffix
	dlx := "anyq-dlx-dlx-" + suffix
	dlq := "anyq-dlx-dlq-" + suffix

	conn := ConnectionConfig{URL: url}
	mainEx := ExchangeConfig{Name: exchange, Type: "direct", Durable: false, AutoDelete: true}
	dlxEx := ExchangeConfig{Name: dlx, Type: "fanout", Durable: false, AutoDelete: true}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Main consumer: queue dead-letters to the DLX after nack(false).
	mainConsumer := NewConsumer(ConsumerConfig{
		BaseQueueConfig: core.BaseQueueConfig{
			Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
				MaxAttempts: 3,
				Backoff:     &core.RetryConfig{InitialDelayMs: 1, MaxDelayMs: 5, Multiplier: 2},
				IsRetryable: func(error) bool { return true },
			}),
		},
		Connection: conn,
		Queue: QueueConfig{
			Name:               queue,
			Durable:            false,
			AutoDelete:         true,
			DeadLetterExchange: dlx,
		},
		Exchange:   &mainEx,
		BindingKey: routingKey,
		Consumer:   ConsumerOptions{Prefetch: 1},
	})

	// DLQ consumer: bound to the DLX so we can observe the dead-lettered message.
	dlqConsumer := NewConsumer(ConsumerConfig{
		Connection: conn,
		Queue:      QueueConfig{Name: dlq, Durable: false, AutoDelete: true},
		Exchange:   &dlxEx,
		BindingKey: "",
		Consumer:   ConsumerOptions{Prefetch: 1},
	})

	producer := NewProducer(ProducerConfig{
		Connection:  conn,
		Exchange:    mainEx,
		RoutingKey:  routingKey,
		ConfirmMode: true,
	})

	if err := dlqConsumer.Connect(ctx); err != nil {
		t.Fatalf("dlq consumer connect: %v", err)
	}
	defer dlqConsumer.Disconnect(context.Background())
	if err := mainConsumer.Connect(ctx); err != nil {
		t.Fatalf("main consumer connect: %v", err)
	}
	defer mainConsumer.Disconnect(context.Background())
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	var attempts int32
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = mainConsumer.Subscribe(subCtx, func(_ context.Context, _ core.Message) error {
			atomic.AddInt32(&attempts, 1)
			return errors.New("boom")
		}, nil)
	}()

	deadLettered := make(chan core.Message, 1)
	go func() {
		_ = dlqConsumer.Subscribe(subCtx, func(_ context.Context, m core.Message) error {
			deadLettered <- m
			return nil
		}, nil)
	}()

	if _, err := producer.Publish(ctx, []byte(`{"will":"fail"}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case m := <-deadLettered:
		if string(m.Body()) != `{"will":"fail"}` {
			t.Fatalf("unexpected dead-lettered body: %s", m.Body())
		}
		if got := atomic.LoadInt32(&attempts); got < 1 {
			t.Fatalf("expected handler to be invoked at least once, got %d", got)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for dead-lettered message")
	}
}
