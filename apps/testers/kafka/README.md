# Kafka Tester

Test application for `@anyq/kafka` adapter using Bun + Hono with Docker.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

### 1. Start Kafka Infrastructure

```bash
# From the monorepo root
cd apps/testers/kafka

# Start Zookeeper, Kafka, and Kafka UI
bun run docker:up

# Wait for Kafka to be ready (about 30 seconds)
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
| `bun run docker:up` | Start Kafka infrastructure |
| `bun run docker:down` | Stop and remove Kafka containers |
| `bun run docker:logs` | View Kafka container logs |

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
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses (comma-separated) |
| `KAFKA_CLIENT_ID` | `anyq-kafka-tester` | Kafka client ID |
| `KAFKA_TOPIC` | `orders` | Topic to publish/consume |
| `KAFKA_GROUP_ID` | `order-processors` | Consumer group ID |

## Kafka UI

Access the Kafka UI at http://localhost:8080 to:

- View topics and partitions
- Browse messages
- Monitor consumer groups
- Manage cluster settings

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  POST /publish  │         │  subscribe()    │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Kafka Cluster                            │
│                                                             │
│   Topic: orders (3 partitions, 1 replica)                   │
│   ┌─────────────┬─────────────┬─────────────┐              │
│   │ Partition 0 │ Partition 1 │ Partition 2 │              │
│   └─────────────┴─────────────┴─────────────┘              │
│                                                             │
│   Consumer Group: order-processors                          │
└─────────────────────────────────────────────────────────────┘
```

## Docker Services

| Service | Port | Description |
|---------|------|-------------|
| Zookeeper | 2181 | Kafka coordination |
| Kafka | 9092 | Kafka broker |
| Kafka UI | 8080 | Web-based management UI |

## Troubleshooting

### Kafka Not Ready

```bash
# Check if Kafka is running
docker ps | grep kafka

# View Kafka logs
docker logs anyq-kafka

# Wait for broker to be ready
docker exec anyq-kafka kafka-topics --bootstrap-server localhost:9092 --list
```

### Consumer Lag

```bash
# Check consumer group lag
docker exec anyq-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group order-processors \
  --describe
```

### Topic Not Created

```bash
# Create topic manually
docker exec anyq-kafka kafka-topics \
  --bootstrap-server localhost:9092 \
  --create --topic orders \
  --partitions 3 \
  --replication-factor 1
```
