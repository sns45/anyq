//go:build integration

// Integration tests for the SQS adapter against LocalStack.
//
// Run with a LocalStack instance available and SQS_ENDPOINT set, e.g.:
//
//	docker compose -f apps/testers/sqs/docker-compose.yml up -d
//	SQS_ENDPOINT=http://localhost:4566 go test -tags integration ./sqs/...
//
// The tests skip automatically when SQS_ENDPOINT is unset.
package sqs

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/sns45/anyq/go/core"
)

func testConn(t *testing.T) (ConnectionConfig, string) {
	t.Helper()
	endpoint := os.Getenv("SQS_ENDPOINT")
	if endpoint == "" {
		t.Skip("SQS_ENDPOINT not set; skipping SQS integration test")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	access := os.Getenv("AWS_ACCESS_KEY_ID")
	if access == "" {
		access = "test"
	}
	secret := os.Getenv("AWS_SECRET_ACCESS_KEY")
	if secret == "" {
		secret = "test"
	}
	return ConnectionConfig{
		Region:          region,
		Endpoint:        endpoint,
		AccessKeyID:     access,
		SecretAccessKey: secret,
	}, region
}

// createQueue creates a fresh queue with a unique name and returns its URL.
func createQueue(t *testing.T, ctx context.Context, conn ConnectionConfig, attrs map[string]string) string {
	t.Helper()
	client, err := NewClient(ctx, conn)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	name := fmt.Sprintf("anyq-go-it-%d", time.Now().UnixNano())
	out, err := client.CreateQueue(ctx, &awssqs.CreateQueueInput{
		QueueName:  aws.String(name),
		Attributes: attrs,
	})
	if err != nil {
		t.Fatalf("CreateQueue: %v", err)
	}
	url := aws.ToString(out.QueueUrl)
	t.Cleanup(func() {
		_, _ = client.DeleteQueue(context.Background(), &awssqs.DeleteQueueInput{QueueUrl: aws.String(url)})
	})
	return url
}

func queueArn(t *testing.T, ctx context.Context, conn ConnectionConfig, url string) string {
	t.Helper()
	client, err := NewClient(ctx, conn)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	out, err := client.GetQueueAttributes(ctx, &awssqs.GetQueueAttributesInput{
		QueueUrl:       aws.String(url),
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameQueueArn},
	})
	if err != nil {
		t.Fatalf("GetQueueAttributes: %v", err)
	}
	return out.Attributes["QueueArn"]
}

// TestPublishConsumeDelete verifies a basic publish -> consume -> delete cycle.
func TestPublishConsumeDelete(t *testing.T) {
	conn, _ := testConn(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	url := createQueue(t, ctx, conn, nil)

	cfg := Config{
		QueueURL: url,
		SQS:      conn,
		Consumer: ConsumerOptions{WaitTimeSeconds: 2, VisibilityTimeout: 10},
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

	body := []byte(`{"orderId":"ORD-1"}`)
	if _, err := producer.Publish(ctx, body, &core.PublishOptions{
		Headers: core.MessageHeaders{"x-test": []byte("hello")},
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	received := make(chan core.Message, 1)
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, m core.Message) error {
			received <- m
			return nil
		}, nil)
	}()

	select {
	case m := <-received:
		if string(m.Body()) != string(body) {
			t.Fatalf("body mismatch: got %q", m.Body())
		}
		if got := string(m.Headers()["x-test"]); got != "hello" {
			t.Fatalf("header mismatch: got %q", got)
		}
		if m.Metadata().SQS == nil || m.Metadata().SQS.ReceiptHandle == "" {
			t.Fatalf("expected SQS metadata with receipt handle")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for message")
	}
	subCancel()

	// The message should have been auto-acked (deleted); confirm the queue drains.
	if !queueDrained(t, ctx, conn, url) {
		t.Fatal("expected queue to be empty after ack")
	}
}

// TestRetryThenDeadLetter verifies that a perpetually-failing handler with a
// RetryThenDeadLetter strategy results in the message being dead-lettered (the
// base default deletes/abandons it) rather than redelivered forever.
func TestRetryThenDeadLetter(t *testing.T) {
	conn, _ := testConn(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// DLQ + main queue with a redrive policy so SQS can move exhausted messages.
	dlqURL := createQueue(t, ctx, conn, nil)
	dlqArn := queueArn(t, ctx, conn, dlqURL)
	redrive := fmt.Sprintf(`{"deadLetterTargetArn":"%s","maxReceiveCount":"2"}`, dlqArn)
	mainURL := createQueue(t, ctx, conn, map[string]string{"RedrivePolicy": redrive})

	cfg := Config{
		QueueURL: mainURL,
		SQS:      conn,
		Consumer: ConsumerOptions{WaitTimeSeconds: 2, VisibilityTimeout: 5},
		BaseQueueConfig: core.BaseQueueConfig{
			Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
				MaxAttempts: 2,
				Backoff:     &core.RetryConfig{InitialDelayMs: 50, MaxDelayMs: 100},
				// Treat the handler error as retryable so the strategy exhausts
				// attempts then dead-letters.
				IsRetryable: func(error) bool { return true },
			}),
		},
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

	if _, err := producer.Publish(ctx, []byte(`{"orderId":"FAIL"}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}

	var attempts int32
	var once sync.Once
	done := make(chan struct{})
	subCtx, subCancel := context.WithCancel(ctx)
	defer subCancel()
	go func() {
		_ = consumer.Subscribe(subCtx, func(_ context.Context, _ core.Message) error {
			if atomic.AddInt32(&attempts, 1) >= 2 {
				once.Do(func() { close(done) })
			}
			return fmt.Errorf("intentional handler failure")
		}, nil)
	}()

	select {
	case <-done:
		// Handler invoked at least twice (in-process retries exhausted).
	case <-time.After(45 * time.Second):
		t.Fatalf("handler not retried enough times: attempts=%d", atomic.LoadInt32(&attempts))
	}

	// After dead-lettering, the message must stop being redelivered. Give the
	// strategy a moment to delete the in-flight copy, then assert the main queue
	// stays empty across a couple of poll windows.
	subCancel()
	time.Sleep(2 * time.Second)
	if !queueDrained(t, ctx, conn, mainURL) {
		t.Fatal("expected main queue to be drained after dead-letter")
	}
}

// queueDrained polls the queue's ApproximateNumberOfMessages until it reports 0
// for a stable window, returning true if drained.
func queueDrained(t *testing.T, ctx context.Context, conn ConnectionConfig, url string) bool {
	t.Helper()
	client, err := NewClient(ctx, conn)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		out, err := client.GetQueueAttributes(ctx, &awssqs.GetQueueAttributesInput{
			QueueUrl: aws.String(url),
			AttributeNames: []sqstypes.QueueAttributeName{
				sqstypes.QueueAttributeNameApproximateNumberOfMessages,
				sqstypes.QueueAttributeNameApproximateNumberOfMessagesNotVisible,
			},
		})
		if err != nil {
			t.Fatalf("GetQueueAttributes: %v", err)
		}
		visible := out.Attributes["ApproximateNumberOfMessages"]
		inflight := out.Attributes["ApproximateNumberOfMessagesNotVisible"]
		if visible == "0" && inflight == "0" {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return false
}
