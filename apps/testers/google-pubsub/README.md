# Google Pub/Sub Tester

Test application for `@anyq/google-pubsub` adapter using the Google Cloud Pub/Sub Emulator.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

### 1. Start Pub/Sub Emulator

```bash
# From the monorepo root
cd apps/testers/google-pubsub

# Start the emulator
bun run docker:up

# Wait for emulator to be ready (about 10-15 seconds)
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
| `bun run docker:up` | Start Pub/Sub emulator |
| `bun run docker:down` | Stop and remove emulator containers |
| `bun run docker:logs` | View emulator container logs |

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
  -d '{
    "orders": [
      {"product": "Widget", "quantity": 1, "price": 9.99},
      {"product": "Gadget", "quantity": 2, "price": 19.99},
      {"product": "Gizmo", "quantity": 3, "price": 29.99}
    ]
  }'
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
| `PUBSUB_PROJECT_ID` | `anyq-local` | GCP Project ID |
| `PUBSUB_EMULATOR_HOST` | `localhost:8085` | Emulator endpoint |
| `PUBSUB_TOPIC` | `orders` | Topic name |
| `PUBSUB_SUBSCRIPTION` | `orders-sub` | Subscription name |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  topic.publish  │         │  subscription   │           │
│  │                 │         │  .on('message') │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                 Google Pub/Sub Emulator                     │
│                                                             │
│   Project: anyq-local                                       │
│                                                             │
│   ┌─────────────────┐     ┌─────────────────┐              │
│   │     Topic       │────►│  Subscription   │              │
│   │    (orders)     │     │  (orders-sub)   │              │
│   └─────────────────┘     └─────────────────┘              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Using with Real Google Cloud

To use with real Google Cloud Pub/Sub:

### 1. Set up GCP Project

```bash
# Create project (or use existing)
gcloud projects create your-project-id

# Enable Pub/Sub API
gcloud services enable pubsub.googleapis.com

# Create topic
gcloud pubsub topics create orders

# Create subscription
gcloud pubsub subscriptions create orders-sub --topic=orders
```

### 2. Configure Authentication

```bash
# Create service account
gcloud iam service-accounts create anyq-pubsub \
  --display-name "anyq Pub/Sub Service Account"

# Grant permissions
gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:anyq-pubsub@your-project-id.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:anyq-pubsub@your-project-id.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# Download key
gcloud iam service-accounts keys create ./service-account-key.json \
  --iam-account=anyq-pubsub@your-project-id.iam.gserviceaccount.com
```

### 3. Update Environment

```bash
export PUBSUB_PROJECT_ID=your-project-id
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
# Remove PUBSUB_EMULATOR_HOST to use real GCP
unset PUBSUB_EMULATOR_HOST
```

### 4. Update Config

Remove `emulatorMode: true` from the producer/consumer config in the source code.

## Troubleshooting

### Emulator Not Ready

```bash
# Check if emulator is running
docker ps | grep pubsub

# Check emulator logs
bun run docker:logs

# Test emulator endpoint
curl http://localhost:8085
```

### Topic/Subscription Not Found

The topic and subscription are created automatically when the producer/consumer connect. If needed, you can create them manually using the gcloud CLI with the emulator:

```bash
# Set emulator host
export PUBSUB_EMULATOR_HOST=localhost:8085

# Create topic
gcloud pubsub topics create orders --project=anyq-local

# Create subscription
gcloud pubsub subscriptions create orders-sub --topic=orders --project=anyq-local
```

### Messages Not Being Received

```bash
# Check subscription
gcloud pubsub subscriptions describe orders-sub --project=anyq-local

# Pull messages manually (for debugging)
gcloud pubsub subscriptions pull orders-sub --project=anyq-local --auto-ack
```
