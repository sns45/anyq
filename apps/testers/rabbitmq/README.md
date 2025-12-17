# RabbitMQ Tester

Test application for `@anyq/rabbitmq` adapter using Bun + Hono with Docker.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)

## Quick Start

### 1. Start RabbitMQ

```bash
# From the monorepo root
cd apps/testers/rabbitmq

# Start RabbitMQ with management UI
bun run docker:up

# Wait for RabbitMQ to be healthy (about 10-15 seconds)
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
| `bun run docker:up` | Start RabbitMQ |
| `bun run docker:down` | Stop and remove RabbitMQ containers |
| `bun run docker:logs` | View RabbitMQ container logs |
| `bun run test` | Start Docker, wait, and run dev server |

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
| `RABBITMQ_URL` | `amqp://localhost:5672` | RabbitMQ connection URL |
| `RABBITMQ_EXCHANGE` | `orders` | Exchange name |
| `RABBITMQ_QUEUE` | `orders.created` | Queue name |
| `RABBITMQ_ROUTING_KEY` | `orders.created` | Routing key |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  Confirm Mode   │         │  Prefetch: 10   │           │
│  │  Persistent     │         │  Manual Ack     │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      RabbitMQ                               │
│                                                             │
│   Exchange: orders (direct)                                 │
│       │                                                     │
│       │ Binding: orders.created                             │
│       ▼                                                     │
│   ┌─────────────────┐                                       │
│   │ Queue:          │                                       │
│   │ orders.created  │                                       │
│   │ (durable)       │                                       │
│   └─────────────────┘                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## RabbitMQ Management UI

Access the management UI at http://localhost:15672

- **Username**: `guest`
- **Password**: `guest`

Features available:
- View exchanges, queues, and bindings
- Monitor message rates and queue depths
- Manage connections and channels
- Publish/consume test messages
- View message contents

## Using with External RabbitMQ

To connect to an external RabbitMQ server:

```bash
export RABBITMQ_URL=amqp://user:password@hostname:5672/vhost
bun run dev
```

## Troubleshooting

### Connection Refused

```bash
# Check if RabbitMQ is running
docker ps | grep rabbitmq

# Check RabbitMQ logs
bun run docker:logs

# Test connection
docker exec anyq-rabbitmq rabbitmq-diagnostics check_port_connectivity
```

### Exchange/Queue Not Found

The exchange and queue are created automatically when the producer/consumer connect. If needed:

```bash
# List exchanges
docker exec anyq-rabbitmq rabbitmqctl list_exchanges

# List queues
docker exec anyq-rabbitmq rabbitmqctl list_queues

# List bindings
docker exec anyq-rabbitmq rabbitmqctl list_bindings
```

### Messages Not Being Consumed

```bash
# Check queue status
docker exec anyq-rabbitmq rabbitmqctl list_queues name messages consumers

# Check consumers
docker exec anyq-rabbitmq rabbitmqctl list_consumers
```

### High Memory Usage

```bash
# Check memory status
docker exec anyq-rabbitmq rabbitmqctl status | grep -A 10 memory

# Set memory limit
docker exec anyq-rabbitmq rabbitmqctl set_vm_memory_high_watermark 0.4
```
