// Command sns-tester is the integration test server for the SNS adapter.
//
// SNS is publish-only, so delivery is verified the same way as the TypeScript
// tester: an SQS queue is subscribed to the SNS topic on startup, and a polling
// goroutine reads from that queue, unwraps the SNS envelope, and records each
// message via the shared tester harness. Topic, queue, and subscription are
// created on startup for convenience (matching the LocalStack init script).
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/sns45/anyq/go/apps/testers/internal/tester"
	"github.com/sns45/anyq/go/core"
	anyqsns "github.com/sns45/anyq/go/sns"
)

// snsEnvelope is the JSON wrapper SNS puts around the message when delivering to
// a raw (non-raw-delivery) SQS subscription.
type snsEnvelope struct {
	Type      string `json:"Type"`
	MessageID string `json:"MessageId"`
	TopicArn  string `json:"TopicArn"`
	Subject   string `json:"Subject"`
	Message   string `json:"Message"`
}

func main() {
	getenv := os.Getenv
	port := tester.EnvOr(getenv, "PORT", "3000")
	region := tester.EnvOr(getenv, "AWS_REGION", "us-east-1")
	snsEndpoint := tester.EnvOr(getenv, "SNS_ENDPOINT", "http://localhost:4566")
	sqsEndpoint := tester.EnvOr(getenv, "SQS_ENDPOINT", "http://localhost:4566")
	accessKey := tester.EnvOr(getenv, "AWS_ACCESS_KEY_ID", "test")
	secretKey := tester.EnvOr(getenv, "AWS_SECRET_ACCESS_KEY", "test")
	topicName := tester.EnvOr(getenv, "SNS_TOPIC_NAME", "orders")
	topicArnEnv := getenv("SNS_TOPIC_ARN")
	queueName := tester.EnvOr(getenv, "SQS_QUEUE_NAME", "orders-subscriber")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Build raw AWS clients used only for topic/queue/subscription bootstrapping
	// and SQS polling (the adapter under test is the SNS producer).
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		log.Fatalf("aws config: %v", err)
	}
	snsClient := sns.NewFromConfig(awsCfg, func(o *sns.Options) { o.BaseEndpoint = aws.String(snsEndpoint) })
	sqsClient := sqs.NewFromConfig(awsCfg, func(o *sqs.Options) { o.BaseEndpoint = aws.String(sqsEndpoint) })

	// Create topic.
	topicArn := topicArnEnv
	if ct, err := snsClient.CreateTopic(ctx, &sns.CreateTopicInput{Name: aws.String(topicName)}); err != nil {
		log.Printf("create topic (continuing): %v", err)
	} else if topicArn == "" {
		topicArn = aws.ToString(ct.TopicArn)
	}
	if topicArn == "" {
		log.Fatalf("no SNS topic ARN available (set SNS_TOPIC_ARN or ensure CreateTopic succeeds)")
	}

	// Create the subscriber queue and resolve its ARN.
	cq, err := sqsClient.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String(queueName)})
	if err != nil {
		log.Fatalf("create queue: %v", err)
	}
	queueURL := aws.ToString(cq.QueueUrl)
	ga, err := sqsClient.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       aws.String(queueURL),
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameQueueArn},
	})
	if err != nil {
		log.Fatalf("get queue attributes: %v", err)
	}
	queueArn := ga.Attributes[string(sqstypes.QueueAttributeNameQueueArn)]

	// Allow SNS to send to the queue, then subscribe it to the topic.
	policy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"` + queueArn + `","Condition":{"ArnEquals":{"aws:SourceArn":"` + topicArn + `"}}}]}`
	if _, err := sqsClient.SetQueueAttributes(ctx, &sqs.SetQueueAttributesInput{
		QueueUrl:   aws.String(queueURL),
		Attributes: map[string]string{string(sqstypes.QueueAttributeNamePolicy): policy},
	}); err != nil {
		log.Printf("set queue policy (continuing): %v", err)
	}
	if _, err := snsClient.Subscribe(ctx, &sns.SubscribeInput{
		TopicArn:              aws.String(topicArn),
		Protocol:              aws.String("sqs"),
		Endpoint:              aws.String(queueArn),
		ReturnSubscriptionArn: true,
	}); err != nil {
		log.Printf("subscribe (continuing): %v", err)
	}

	// Wire up the SNS producer (the adapter under test).
	producer := anyqsns.NewProducer(anyqsns.Config{
		TopicArn: topicArn,
		SNS: anyqsns.ConnectionConfig{
			Region:          region,
			Endpoint:        snsEndpoint,
			AccessKeyID:     accessKey,
			SecretAccessKey: secretKey,
		},
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "sns-tester"},
	})
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}

	consumerConnected := true
	app := &tester.App{
		Service:           "anyq-tester-sns",
		Producer:          producer,
		ConsumerConnected: func() bool { return consumerConnected },
		ExtraStats: func() map[string]any {
			return map[string]any{
				"sns": map[string]any{"topicArn": topicArn},
				"sqs": map[string]any{"queueUrl": queueURL, "queueArn": queueArn},
			}
		},
	}

	// Poll the subscribed SQS queue, unwrap the SNS envelope, and record each
	// delivered message.
	go pollSQS(ctx, sqsClient, queueURL, app)

	srv := &http.Server{Addr: ":" + port, Handler: app.Handler()}
	go func() {
		log.Printf("SNS tester listening on http://localhost:%s", port)
		log.Printf("topic=%s queue=%s", topicArn, queueURL)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("shutting down...")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
	_ = producer.Disconnect(context.Background())
}

// pollSQS long-polls the queue and reports each message to the tester app. The
// inner message body is extracted from the SNS envelope when present.
func pollSQS(ctx context.Context, client *sqs.Client, queueURL string, app *tester.App) {
	for {
		if ctx.Err() != nil {
			return
		}
		out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            aws.String(queueURL),
			MaxNumberOfMessages: 10,
			WaitTimeSeconds:     5,
			VisibilityTimeout:   30,
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("receive: %v", err)
			time.Sleep(time.Second)
			continue
		}
		for _, m := range out.Messages {
			received := time.Now()
			id, body := unwrap(aws.ToString(m.MessageId), aws.ToString(m.Body))
			log.Printf("received order %s via SNS->SQS", id)
			app.RecordConsumed(id, body, received)
			if _, err := client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(queueURL),
				ReceiptHandle: m.ReceiptHandle,
			}); err != nil {
				log.Printf("delete message: %v", err)
			}
		}
	}
}

// unwrap returns the inner message id and body. SNS delivers a JSON envelope to
// SQS; if the body parses as an envelope with a Type field, the inner Message is
// returned. Otherwise (e.g. raw message delivery) the body is returned as-is.
func unwrap(sqsMessageID, body string) (string, []byte) {
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "{") {
		var env snsEnvelope
		if err := json.Unmarshal([]byte(trimmed), &env); err == nil && env.Type != "" && env.Message != "" {
			id := env.MessageID
			if id == "" {
				id = sqsMessageID
			}
			return id, []byte(env.Message)
		}
	}
	return sqsMessageID, []byte(body)
}
