# anyq

A universal message queue library providing a unified interface across multiple queue systems. Write once, run on any queue.

## Features

- **Unified API** - Same `IProducer` and `IConsumer` interfaces across all adapters
- **10 Adapters** - Support for all major message queue systems
- **TypeScript First** - Full type safety with generic message types
- **Message Acknowledgment** - `ack()`, `nack()`, and `extendDeadline()` on all adapters
- **Dead Letter Queue** - Built-in DLQ support
- **Middleware** - Circuit breaker and retry with exponential backoff
- **Serialization** - JSON (built-in) and Avro (Kafka)

## Supported Queue Systems

| Adapter | Package | Use Case |
|---------|---------|----------|
| In-Memory | `@anyq/memory` | Testing, development |
| Redis Streams | `@anyq/redis-streams` | Lightweight streaming |
| RabbitMQ | `@anyq/rabbitmq` | AMQP messaging |
| AWS SQS | `@anyq/sqs` | Cloud-managed queues |
| AWS SNS | `@anyq/sns` | Fan-out pub/sub |
| Google Pub/Sub | `@anyq/google-pubsub` | GCP messaging |
| Apache Kafka | `@anyq/kafka` | High-throughput streaming |
| NATS JetStream | `@anyq/nats` | Lightweight persistence |
| Azure Service Bus | `@anyq/azure-servicebus` | Azure messaging |

## Quick Start

### Installation

```bash
# Install core (required)
bun add @anyq/core

# Install the adapter you need
bun add @anyq/redis-streams  # or any other adapter
```

### Basic Usage

```typescript
import { createRedisProducer, createRedisConsumer } from '@anyq/redis-streams';

// Create producer
const producer = createRedisProducer({
  connection: { host: 'localhost', port: 6379 },
  stream: { name: 'orders' }
});

await producer.connect();
await producer.publish({ orderId: '123', product: 'Widget' });

// Create consumer
const consumer = createRedisConsumer({
  connection: { host: 'localhost', port: 6379 },
  stream: { name: 'orders' },
  consumer: { groupName: 'order-processor', consumerName: 'worker-1' }
});

await consumer.connect();
await consumer.subscribe(async (message) => {
  console.log('Received:', message.body);
  await message.ack();
});
```

## Project Structure

```
anyq/
├── packages/           # NPM packages (adapters)
│   ├── core/          # Core interfaces and utilities
│   ├── memory/        # In-memory adapter
│   ├── redis-streams/ # Redis Streams adapter
│   ├── rabbitmq/      # RabbitMQ adapter
│   ├── sqs/           # AWS SQS adapter
│   ├── sns/           # AWS SNS adapter
│   ├── google-pubsub/ # Google Pub/Sub adapter
│   ├── kafka/         # Apache Kafka adapter
│   ├── nats/          # NATS JetStream adapter
│   └── azure-servicebus/ # Azure Service Bus adapter
├── apps/
│   └── testers/       # Test applications for each adapter
├── package.json       # Root workspace configuration
├── tsconfig.json      # Base TypeScript configuration
├── bunfig.toml        # Bun configuration
└── bun.lock           # Dependency lock file
```

### Root Files

| File | Description |
|------|-------------|
| `package.json` | Bun workspace configuration, defines workspaces for packages and apps |
| `tsconfig.json` | Base TypeScript config inherited by all packages |
| `bunfig.toml` | Bun runtime configuration |
| `bun.lock` | Locked dependency versions |
| `.gitignore` | Git ignore patterns |

### Packages (`packages/`)

Each package follows the same structure:

```
packages/{adapter}/
├── src/
│   ├── index.ts      # Public exports
│   ├── config.ts     # Configuration types
│   ├── producer.ts   # Producer implementation
│   └── consumer.ts   # Consumer implementation
├── package.json      # Package metadata and dependencies
└── tsconfig.json     # TypeScript config (extends root)
```

#### Core Package (`@anyq/core`)

The foundation package containing:

| Directory | Contents |
|-----------|----------|
| `types/` | `IProducer`, `IConsumer`, `IMessage`, config interfaces |
| `base/` | `BaseProducer`, `BaseConsumer` abstract classes |
| `middleware/` | Circuit breaker, retry logic |
| `serialization/` | JSON serializer, serializer interface |
| `utils/` | Logger, ID generator, backoff calculator |

#### Adapter Packages

Each adapter implements the core interfaces for a specific queue system:

| Package | Dependencies | Notes |
|---------|--------------|-------|
| `@anyq/memory` | None | No external dependencies |
| `@anyq/redis-streams` | `ioredis` | Redis 5.0+ required |
| `@anyq/rabbitmq` | `amqplib` | AMQP 0-9-1 protocol |
| `@anyq/sqs` | `@aws-sdk/client-sqs` | AWS SDK v3 |
| `@anyq/sns` | `@aws-sdk/client-sns` | Producer only (fan-out) |
| `@anyq/google-pubsub` | `@google-cloud/pubsub` | GCP client library |
| `@anyq/kafka` | `kafkajs` | Includes Avro support |
| `@anyq/nats` | `nats` | JetStream required |
| `@anyq/azure-servicebus` | `@azure/service-bus` | Azure SDK |

### Test Applications (`apps/testers/`)

Each tester is a standalone Hono web server for testing an adapter:

```
apps/testers/{adapter}/
├── src/
│   ├── index.ts        # Hono server entry point
│   ├── config.ts       # Environment configuration
│   ├── producer.ts     # Producer setup
│   ├── consumer.ts     # Consumer with message logging
│   └── routes/
│       ├── health.ts   # GET /health
│       ├── publish.ts  # POST /publish, /publish/batch, /publish/test
│       └── stats.ts    # GET /stats, /stats/messages
├── docker-compose.yml  # Local infrastructure
├── package.json        # Tester dependencies
└── README.md           # Setup and usage instructions
```

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) (for running queue infrastructure)
- Node.js >= 18 (optional)

### Install Dependencies

```bash
# Clone the repository
git clone https://github.com/sns45/anyq.git
cd anyq

# Install all dependencies
bun install
```

### Build All Packages

```bash
bun run build
```

### Run Tests

```bash
bun test
```

### Running a Tester

Each tester has its own Docker setup:

```bash
# Example: Redis Streams tester
cd apps/testers/redis-streams

# Start infrastructure
bun run docker:up

# Start the tester server
bun run dev

# Test endpoints
curl http://localhost:3000/health
curl -X POST http://localhost:3000/publish/test
curl http://localhost:3000/stats
```

## API Reference

### Producer Interface

```typescript
interface IProducer<T> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(message: T, options?: PublishOptions): Promise<PublishResult>;
  publishBatch(messages: T[], options?: PublishOptions): Promise<PublishResult[]>;
  isConnected(): boolean;
}
```

### Consumer Interface

```typescript
interface IConsumer<T> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(handler: MessageHandler<T>): Promise<void>;
  unsubscribe(): Promise<void>;
  pause(): void;
  resume(): void;
  isConnected(): boolean;
  isPaused(): boolean;
}
```

### Message Interface

```typescript
interface IMessage<T> {
  id: string;
  body: T;
  metadata: MessageMetadata;
  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
  extendDeadline?(seconds: number): Promise<void>;
}
```

## Configuration Examples

### Redis Streams

```typescript
const config = {
  connection: { host: 'localhost', port: 6379 },
  stream: { name: 'my-stream' },
  consumer: {
    groupName: 'my-group',
    consumerName: 'worker-1'
  }
};
```

### Kafka

```typescript
const config = {
  connection: {
    brokers: ['localhost:9092'],
    clientId: 'my-app'
  },
  topic: { name: 'my-topic' },
  consumer: { groupId: 'my-group' }
};
```

### AWS SQS

```typescript
const config = {
  connection: {
    region: 'us-east-1',
    // credentials from environment or IAM role
  },
  queue: {
    url: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue'
  }
};
```

## Switching Adapters

The unified interface makes switching between queue systems straightforward:

```typescript
// Before: Redis
import { createRedisProducer } from '@anyq/redis-streams';
const producer = createRedisProducer(redisConfig);

// After: Kafka (same interface)
import { createKafkaProducer } from '@anyq/kafka';
const producer = createKafkaProducer(kafkaConfig);

// Usage remains identical
await producer.connect();
await producer.publish({ orderId: '123' });
```

## Environment Variables

Common environment variables used by testers:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `REDIS_HOST` | Redis host | `localhost` |
| `RABBITMQ_URL` | RabbitMQ connection URL | `amqp://localhost:5672` |
| `AWS_REGION` | AWS region | `us-east-1` |
| `KAFKA_BROKERS` | Kafka broker list | `localhost:9092` |
| `NATS_URL` | NATS server URL | `nats://localhost:4222` |
| `PUBSUB_EMULATOR_HOST` | Pub/Sub emulator | `localhost:8085` |

## Troubleshooting

### Connection Issues

1. Ensure Docker containers are running: `docker ps`
2. Check container logs: `docker logs <container-name>`
3. Verify ports are not in use: `lsof -i :<port>`

### TypeScript Errors

1. Rebuild packages: `bun run build`
2. Clear dist folders: `rm -rf packages/*/dist`
3. Reinstall dependencies: `rm -rf node_modules && bun install`

### Platform-Specific Issues

- **Azure Service Bus on ARM64 (Apple Silicon)**: The emulator has known issues. Use real Azure Service Bus or an x86 machine. See `apps/testers/azure-servicebus/README.md` for workarounds.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `bun test`
5. Build packages: `bun run build`
6. Submit a pull request

## License

MIT

## Links

- [Repository](https://github.com/sns45/anyq)
- [Issues](https://github.com/sns45/anyq/issues)
