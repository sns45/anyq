# SQS Tester

Test application for `@anyq/sqs` adapter using LocalStack.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)
- AWS CLI (optional, for manual queue management)

## Quick Start

### 1. Start LocalStack

```bash
# From the monorepo root
cd apps/testers/sqs

# Start LocalStack with SQS
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
| `/health` | GET | Health check (producer/consumer status) |
| `/publish` | POST | Publish a single message |
| `/publish/batch` | POST | Publish multiple messages |
| `/publish/test` | POST | Publish a random test message |
| `/stats` | GET | Get producer/consumer statistics |
| `/stats/messages` | GET | Get recent consumed messages |

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

# With limit
curl "http://localhost:3000/stats/messages?limit=5"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AWS_REGION` | `us-east-1` | AWS region |
| `AWS_ENDPOINT` | `http://localhost:4566` | LocalStack endpoint |
| `AWS_ACCESS_KEY_ID` | `test` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | `test` | AWS secret key |
| `SQS_QUEUE_URL` | `http://localhost:4566/000000000000/orders` | SQS queue URL |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  SendMessage    │         │  ReceiveMessage │           │
│  │  SendBatch      │         │  DeleteMessage  │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    LocalStack (SQS)                         │
│                                                             │
│   Queue: orders                                             │
│   ┌─────────────────────────────────────────────┐          │
│   │ Message → Message → Message → ...           │          │
│   └─────────────────────────────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Manual Queue Management

If the queue wasn't created automatically:

```bash
# Create queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name orders

# List queues
aws --endpoint-url=http://localhost:4566 sqs list-queues

# Get queue attributes
aws --endpoint-url=http://localhost:4566 sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/orders \
  --attribute-names All

# Purge queue
aws --endpoint-url=http://localhost:4566 sqs purge-queue \
  --queue-url http://localhost:4566/000000000000/orders
```

## Using with Real AWS

To use with real AWS SQS:

1. Create an SQS queue in AWS Console
2. Configure IAM credentials with SQS permissions
3. Update environment variables:
   ```bash
   export AWS_REGION=us-east-1
   export AWS_ACCESS_KEY_ID=your-access-key
   export AWS_SECRET_ACCESS_KEY=your-secret-key
   export SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/orders
   ```
4. Remove `AWS_ENDPOINT` (or unset it)

## Troubleshooting

### Connection Refused

```bash
# Check if LocalStack is running
docker ps | grep localstack

# Check LocalStack logs
bun run docker:logs

# Check LocalStack health
curl http://localhost:4566/_localstack/health
```

### Queue Not Found

```bash
# List all queues
aws --endpoint-url=http://localhost:4566 sqs list-queues

# Create queue manually
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name orders
```
