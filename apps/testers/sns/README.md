# SNS Tester

Test application for `@anyq/sns` adapter using LocalStack.

SNS is a publish-only service (fan-out pattern). This tester uses an SQS subscription to verify message delivery.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)
- AWS CLI (optional, for manual resource management)

## Quick Start

### 1. Start LocalStack

```bash
# From the monorepo root
cd apps/testers/sns

# Start LocalStack with SNS and SQS
bun run docker:up

# Wait for LocalStack to be ready (about 10 seconds)
```

### 2. Run the Tester

```bash
bun run dev
```

The server will start at http://localhost:3000

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start development server with hot reload |
| `bun run start` | Start production server |
| `bun run docker:up` | Start LocalStack |
| `bun run docker:down` | Stop and remove LocalStack containers |
| `bun run docker:logs` | View LocalStack container logs |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and available endpoints |
| `/health` | GET | Health check (producer status) |
| `/publish` | POST | Publish a single message |
| `/publish/batch` | POST | Publish multiple messages |
| `/publish/test` | POST | Publish a random test message |
| `/stats` | GET | Get producer/consumer statistics |
| `/stats/messages` | GET | Get recent consumed messages (via SQS) |

## Example Usage

### Service Info

```bash
curl http://localhost:3000/
```

### Health Check

```bash
curl http://localhost:3000/health
```

### Publish a Test Message

```bash
curl -X POST http://localhost:3000/publish/test
```

### Publish a Custom Order

```bash
curl -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORD-001",
    "product": "Widget",
    "quantity": 2,
    "price": 29.99
  }'
```

### Publish Batch of Orders

```bash
curl -X POST http://localhost:3000/publish/batch \
  -H "Content-Type: application/json" \
  -d '[
    {"orderId": "ORD-002", "product": "Widget", "quantity": 1, "price": 9.99},
    {"orderId": "ORD-003", "product": "Gadget", "quantity": 2, "price": 19.99}
  ]'
```

### Check Statistics

```bash
curl http://localhost:3000/stats
```

### View Recent Consumed Messages

```bash
curl http://localhost:3000/stats/messages
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AWS_REGION` | `us-east-1` | AWS region |
| `AWS_ENDPOINT` | `http://localhost:4566` | LocalStack endpoint |
| `AWS_ACCESS_KEY_ID` | `test` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | `test` | AWS secret key |
| `SNS_TOPIC_ARN` | `arn:aws:sns:us-east-1:000000000000:orders` | SNS topic ARN |
| `SQS_QUEUE_URL` | `http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders-subscriber` | SQS queue URL |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│                                                             │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │ SNS Producer    │         │ SQS Consumer    │           │
│  │                 │         │                 │           │
│  │ POST /publish   │         │ ReceiveMessage  │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           ▲                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           │
┌───────────────────────────────────────┼─────────────────────┐
│               LocalStack              │                     │
│                                       │                     │
│  ┌─────────────────┐                  │                     │
│  │   SNS Topic     │                  │                     │
│  │   (orders)      │──────────────────┼──►  Other          │
│  │                 │                  │     Subscribers     │
│  └────────┬────────┘                  │     (Lambda, HTTP)  │
│           │                           │                     │
│           │  Subscription             │                     │
│           ▼                           │                     │
│  ┌─────────────────┐                  │                     │
│  │   SQS Queue     │──────────────────┘                     │
│  │   (subscriber)  │                                        │
│  └─────────────────┘                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Manual Resource Management

If resources weren't created automatically:

```bash
# Create SNS topic
aws --endpoint-url=http://localhost:4566 sns create-topic --name orders

# Create SQS queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name orders-subscriber

# Subscribe SQS to SNS
aws --endpoint-url=http://localhost:4566 sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:orders \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:orders-subscriber

# List subscriptions
aws --endpoint-url=http://localhost:4566 sns list-subscriptions
```

## Using with Real AWS

To use with real AWS SNS:

1. Create an SNS topic in AWS Console
2. Create an SQS queue and subscribe it to the topic
3. Configure IAM credentials with SNS/SQS permissions
4. Update environment variables:
   ```bash
   export AWS_REGION=us-east-1
   export AWS_ACCESS_KEY_ID=your-access-key
   export AWS_SECRET_ACCESS_KEY=your-secret-key
   export SNS_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:orders
   export SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/orders-subscriber
   ```
5. Remove `AWS_ENDPOINT` (or unset it)

## Troubleshooting

### Messages Not Appearing in Consumer

```bash
# Check subscription exists
aws --endpoint-url=http://localhost:4566 sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:us-east-1:000000000000:orders

# Check SQS queue for messages
aws --endpoint-url=http://localhost:4566 sqs receive-message \
  --queue-url http://localhost:4566/000000000000/orders-subscriber
```

### Topic Not Found

```bash
# List all topics
aws --endpoint-url=http://localhost:4566 sns list-topics

# Create topic manually
aws --endpoint-url=http://localhost:4566 sns create-topic --name orders
```
