# Memory Tester

Test application for `@anyq/memory` adapter using Bun + Hono.

The in-memory adapter is perfect for testing and development - no external infrastructure required.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

```bash
# From the monorepo root
cd apps/testers/memory

# Install dependencies (if not already done from root)
bun install

# Start the development server
bun run dev
```

The server will start at http://localhost:3000

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start development server with hot reload |
| `bun run start` | Start production server |

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
| `QUEUE_NAME` | `test-orders` | Queue name |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Memory Tester Service                     │
│                                                             │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  POST /publish  │──────►  │  subscribe()    │           │
│  │                 │  Queue  │                 │           │
│  └─────────────────┘         └─────────────────┘           │
│                                                             │
│  In-Memory Queue: No external dependencies                  │
└─────────────────────────────────────────────────────────────┘
```

The tester runs both producer and consumer in the same process:

1. **Producer**: Handles `/publish` endpoints, adds messages to the in-memory queue
2. **Consumer**: Subscribes to the queue and processes messages
3. **Stats**: Tracks published/consumed counts

## Use Cases

- Unit testing
- Local development
- CI/CD pipelines
- Quick prototyping
