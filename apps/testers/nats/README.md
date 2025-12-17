# NATS Tester

Test application for `@anyq/nats` adapter using NATS JetStream.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

### 1. Start NATS

```bash
# From the monorepo root
cd apps/testers/nats

# Start NATS with JetStream enabled
bun run docker:up

# Wait for NATS to be ready (about 5 seconds)
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
| `bun run docker:up` | Start NATS with JetStream |
| `bun run docker:down` | Stop and remove NATS containers |
| `bun run docker:logs` | View NATS container logs |

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
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `NATS_STREAM` | `ORDERS` | JetStream stream name |
| `NATS_SUBJECT` | `orders.created` | Subject to publish/subscribe |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  js.publish()   │         │  Durable Pull   │           │
│  │                 │         │  Consumer       │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    NATS JetStream                           │
│                                                             │
│   Stream: ORDERS                                            │
│   ┌─────────────────────────────────────────────┐          │
│   │ Subjects: orders.*                          │          │
│   │ Storage: Memory                             │          │
│   │ Retention: WorkQueue                        │          │
│   └─────────────────────────────────────────────┘          │
│                                                             │
│   Durable Consumer: orders-processor                        │
│   └── Deliver Policy: All                                  │
│   └── Ack Wait: 30s                                        │
│   └── Max Deliver: 3                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## NATS Monitoring

NATS exposes a monitoring endpoint at http://localhost:8222

```bash
# Server info
curl http://localhost:8222/varz

# JetStream info
curl http://localhost:8222/jsz

# Stream details
curl http://localhost:8222/jsz?streams=true

# Connections
curl http://localhost:8222/connz

# Subscriptions
curl http://localhost:8222/subsz
```

## Using NATS CLI

Install the NATS CLI for advanced management:

```bash
# Install NATS CLI (macOS)
brew install nats-io/nats-tools/nats

# List streams
nats stream ls

# Stream info
nats stream info ORDERS

# Consumer info
nats consumer info ORDERS orders-processor

# Publish a test message
nats pub orders.created '{"orderId":"TEST-001","product":"Test"}'
```

## Troubleshooting

### Connection Refused

```bash
# Check if NATS is running
docker ps | grep nats

# Check NATS logs
bun run docker:logs

# Test connection
curl http://localhost:8222/varz
```

### Stream Not Found

The stream is created automatically when the producer connects. If needed:

```bash
# Create stream manually
nats stream add ORDERS \
  --subjects "orders.*" \
  --storage memory \
  --retention work \
  --max-msgs 10000
```

### Consumer Issues

```bash
# Check consumer status
nats consumer info ORDERS orders-processor

# View pending messages
nats consumer next ORDERS orders-processor --count 1
```
