#!/bin/bash

# Create SNS topic
awslocal sns create-topic --name orders

# Create SQS queue for subscription
awslocal sqs create-queue --queue-name orders-subscriber

# Get ARNs
TOPIC_ARN=$(awslocal sns list-topics --query 'Topics[?contains(TopicArn, `orders`)].TopicArn' --output text)
QUEUE_ARN="arn:aws:sqs:us-east-1:000000000000:orders-subscriber"

# Subscribe SQS to SNS
awslocal sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol sqs \
  --notification-endpoint "$QUEUE_ARN"

echo "SNS topic 'orders' created: $TOPIC_ARN"
echo "SQS queue 'orders-subscriber' subscribed to topic"
