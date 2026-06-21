//go:build integration

// Integration test for the SNS producer against LocalStack.
//
// It is skipped unless SNS_ENDPOINT is set. It creates a topic, creates an SQS
// queue subscribed to that topic, publishes a message via the adapter, then
// asserts the message is delivered to the subscribed queue (unwrapping the SNS
// envelope).
//
//	docker compose -f apps/testers/sns/docker-compose.yml up -d
//	SNS_ENDPOINT=http://localhost:4566 SQS_ENDPOINT=http://localhost:4566 \
//	  go test -tags integration ./sns/...
package sns

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/sns45/anyq/go/core"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func TestSNSPublishDeliveredToSQS(t *testing.T) {
	snsEndpoint := os.Getenv("SNS_ENDPOINT")
	if snsEndpoint == "" {
		t.Skip("SNS_ENDPOINT not set; skipping integration test")
	}
	sqsEndpoint := envOr("SQS_ENDPOINT", snsEndpoint)
	region := envOr("AWS_REGION", "us-east-1")
	accessKey := envOr("AWS_ACCESS_KEY_ID", "test")
	secretKey := envOr("AWS_SECRET_ACCESS_KEY", "test")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}
	snsClient := sns.NewFromConfig(awsCfg, func(o *sns.Options) { o.BaseEndpoint = aws.String(snsEndpoint) })
	sqsClient := sqs.NewFromConfig(awsCfg, func(o *sqs.Options) { o.BaseEndpoint = aws.String(sqsEndpoint) })

	suffix := time.Now().UnixNano()
	topicName := fmt.Sprintf("anyq-it-topic-%d", suffix)
	queueName := fmt.Sprintf("anyq-it-queue-%d", suffix)

	ct, err := snsClient.CreateTopic(ctx, &sns.CreateTopicInput{Name: aws.String(topicName)})
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	topicArn := aws.ToString(ct.TopicArn)

	cq, err := sqsClient.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String(queueName)})
	if err != nil {
		t.Fatalf("create queue: %v", err)
	}
	queueURL := aws.ToString(cq.QueueUrl)

	ga, err := sqsClient.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       aws.String(queueURL),
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameQueueArn},
	})
	if err != nil {
		t.Fatalf("get queue attributes: %v", err)
	}
	queueArn := ga.Attributes[string(sqstypes.QueueAttributeNameQueueArn)]

	policy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"` + queueArn + `"}]}`
	if _, err := sqsClient.SetQueueAttributes(ctx, &sqs.SetQueueAttributesInput{
		QueueUrl:   aws.String(queueURL),
		Attributes: map[string]string{string(sqstypes.QueueAttributeNamePolicy): policy},
	}); err != nil {
		t.Fatalf("set queue policy: %v", err)
	}
	if _, err := snsClient.Subscribe(ctx, &sns.SubscribeInput{
		TopicArn:              aws.String(topicArn),
		Protocol:              aws.String("sqs"),
		Endpoint:              aws.String(queueArn),
		ReturnSubscriptionArn: true,
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	producer := NewProducer(Config{
		TopicArn: topicArn,
		SNS: ConnectionConfig{
			Region:          region,
			Endpoint:        snsEndpoint,
			AccessKeyID:     accessKey,
			SecretAccessKey: secretKey,
		},
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "sns-it"},
	})
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer producer.Disconnect(context.Background())

	want := fmt.Sprintf(`{"orderId":"IT-%d"}`, suffix)
	if _, err := producer.Publish(ctx, []byte(want), &core.PublishOptions{
		Headers: core.MessageHeaders{"source": []byte("integration-test")},
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		out, err := sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            aws.String(queueURL),
			MaxNumberOfMessages: 10,
			WaitTimeSeconds:     5,
		})
		if err != nil {
			t.Fatalf("receive: %v", err)
		}
		for _, m := range out.Messages {
			body := aws.ToString(m.Body)
			inner := body
			if strings.HasPrefix(strings.TrimSpace(body), "{") {
				var env struct {
					Type    string `json:"Type"`
					Message string `json:"Message"`
				}
				if json.Unmarshal([]byte(body), &env) == nil && env.Type != "" {
					inner = env.Message
				}
			}
			if inner == want {
				return // delivered
			}
		}
	}
	t.Fatalf("message %q not delivered to SQS within deadline", want)
}
