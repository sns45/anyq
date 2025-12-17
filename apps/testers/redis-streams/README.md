# Redis Streams Tester

Test application for `@anyq/redis-streams` adapter using Bun + Hono with Docker.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

### Option 1: Using Docker Compose (Recommended)

```bash
# From the monorepo root
cd apps/testers/redis-streams

# Start Redis + wait for health
bun run docker:up

# Start the tester (in another terminal)
bun run dev
```

### Option 2: Local Development with External Redis

```bash
# Start Redis separately
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Start the tester
bun run dev
```

The server will start at http://localhost:3001

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start development server with hot reload |
| `bun run start` | Start production server |
| `bun run docker:up` | Start Redis with Docker Compose |
| `bun run docker:down` | Stop and remove Redis containers |
| `bun run docker:logs` | View Redis container logs |

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
| `/stats/pause` | POST | Pause consumer |
| `/stats/resume` | POST | Resume consumer |

## Example Usage

### Service Info

```bash
curl http://localhost:3001/
```

### Health Check

```bash
curl http://localhost:3001/health
```

### Publish a Test Message

```bash
curl -X POST http://localhost:3001/publish/test
```

### Publish a Custom Order

```bash
curl -X POST http://localhost:3001/publish \
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
curl -X POST http://localhost:3001/publish/batch \
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
curl http://localhost:3001/stats
```

### View Recent Consumed Messages

```bash
curl http://localhost:3001/stats/messages
```

### Pause/Resume Consumer

```bash
# Pause
curl -X POST http://localhost:3001/stats/pause

# Resume
curl -X POST http://localhost:3001/stats/resume
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | - | Redis password (optional) |
| `STREAM_NAME` | `orders` | Redis stream name |
| `CONSUMER_GROUP` | `order-processors` | Consumer group name |
| `CONSUMER_NAME` | `consumer-{pid}` | Consumer name |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  POST /publish  │         │  subscribe()    │           │
│  │    ────────►    │         │  ◄────────      │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
│           │    XADD                   │    XREADGROUP      │
│           ▼                           ▼                     │
└───────────┴───────────────────────────┴─────────────────────┘
            │                           │
            │      Redis Streams        │
┌───────────▼───────────────────────────▼─────────────────────┐
│                                                             │
│   Stream: orders                                            │
│   ┌─────┬─────┬─────┬─────┬─────┐                          │
│   │ ... │ msg │ msg │ msg │ ... │                          │
│   └─────┴─────┴─────┴─────┴─────┘                          │
│                                                             │
│   Consumer Group: order-processors                          │
│   └── Consumer: consumer-{pid}                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Redis Streams Features Used

- **XADD**: Add messages to stream with auto-generated IDs
- **XREADGROUP**: Read messages using consumer groups
- **XACK**: Acknowledge processed messages
- **XAUTOCLAIM**: Auto-claim stuck messages from failed consumers
- **MAXLEN**: Automatic stream trimming

## Monitoring with Redis Commander

If using the full Docker Compose setup, access Redis Commander at http://localhost:8081 to:

- View stream contents
- Monitor consumer groups
- Check pending messages
- Inspect message details

## Troubleshooting

### Connection Refused

```bash
# Check if Redis is running
docker ps | grep redis

# Check Redis logs
bun run docker:logs
```

### Consumer Not Receiving Messages

```bash
# Check consumer group exists
docker exec anyq-redis redis-cli XINFO GROUPS orders

# Check pending messages
docker exec anyq-redis redis-cli XPENDING orders order-processors
```
