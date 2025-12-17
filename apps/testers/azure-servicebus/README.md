# Azure Service Bus Tester

Test application for `@anyq/azure-servicebus` adapter using the Azure Service Bus Emulator.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js >= 18 (optional, for npm compatibility)
- At least 4GB RAM available for Docker (emulator is resource-intensive)

## Quick Start

### 1. Start Azure Service Bus Emulator

```bash
# From the monorepo root
cd apps/testers/azure-servicebus

# Start the emulator (includes SQL Server)
bun run docker:up

# Wait for emulator to be healthy (about 30-60 seconds)
# SQL Server needs to start first, then the Service Bus emulator
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
| `bun run docker:up` | Start Service Bus emulator |
| `bun run docker:down` | Stop and remove emulator containers |
| `bun run docker:logs` | View emulator container logs |
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
| `SERVICEBUS_CONNECTION_STRING` | (emulator default) | Azure Service Bus connection string |
| `SERVICEBUS_QUEUE` | `orders` | Queue name |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tester Service                           │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │    Producer     │         │    Consumer     │           │
│  │                 │         │                 │           │
│  │  SendMessage    │         │  PeekLock Mode  │           │
│  │  SendBatch      │         │  Auto-Renew     │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Azure Service Bus Emulator                     │
│                                                             │
│   Namespace: anyq-namespace                                 │
│                                                             │
│   ┌─────────────────┐                                       │
│   │ Queue: orders   │                                       │
│   │                 │                                       │
│   │ Max Delivery: 10│                                       │
│   │ Lock: 1 minute  │                                       │
│   └─────────────────┘                                       │
│                                                             │
│   ┌─────────────────┐                                       │
│   │   SQL Server    │  (State Storage)                     │
│   └─────────────────┘                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Emulator Configuration

The emulator is configured via `config/Config.json`:

```json
{
  "UserConfig": {
    "Namespaces": [
      {
        "Name": "anyq-namespace",
        "Queues": [
          {
            "Name": "orders",
            "Properties": {
              "MaxDeliveryCount": 10,
              "LockDuration": "PT1M",
              "MaxSizeInMegabytes": 1024
            }
          }
        ],
        "Topics": []
      }
    ]
  }
}
```

### Connection String for Emulator

```
Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true
```

## Using with Real Azure Service Bus

### 1. Create Resources in Azure Portal

1. Create a Service Bus namespace
2. Create a queue named `orders`
3. Get the connection string from Shared access policies

### 2. Update Environment

```bash
export SERVICEBUS_CONNECTION_STRING="Endpoint=sb://your-namespace.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=your-key"
export SERVICEBUS_QUEUE=orders
bun run dev
```

### 3. Using Azure CLI

```bash
# Create namespace
az servicebus namespace create \
  --name your-namespace \
  --resource-group your-rg \
  --sku Standard

# Create queue
az servicebus queue create \
  --name orders \
  --namespace-name your-namespace \
  --resource-group your-rg

# Get connection string
az servicebus namespace authorization-rule keys list \
  --name RootManageSharedAccessKey \
  --namespace-name your-namespace \
  --resource-group your-rg \
  --query primaryConnectionString \
  --output tsv
```

## Troubleshooting

### ARM64/Apple Silicon (M1/M2/M3) Limitations

**Important**: The Azure Service Bus Emulator has known issues running on ARM64 (Apple Silicon Macs):

- SQL Server 2022 doesn't run natively on ARM64
- Azure SQL Edge may crash due to memory mapping issues
- The emulator is primarily designed for x86-64 Linux/Windows

**Workarounds for ARM64 users**:

1. **Use Real Azure Service Bus** (Recommended) - See "Alternative: Use Real Azure" section below
2. **Use a remote x86-64 machine** - Run the emulator on an Intel-based system
3. **Use GitHub Codespaces** - Provides an x86-64 environment in the cloud
4. **Use Colima with Rosetta** - Enable Rosetta emulation in Colima for better x86 compatibility:
   ```bash
   colima start --arch x86_64 --cpu 4 --memory 6
   ```

### Emulator Not Starting

The emulator requires SQL Server to start first:

```bash
# Check container status
docker ps -a | grep anyq-servicebus

# Check SQL Server logs
docker logs anyq-servicebus-sql

# Check Service Bus emulator logs
docker logs anyq-servicebus
```

### Connection Timeout

```bash
# Verify emulator is listening
netstat -an | grep 5672

# Test with Azure CLI (if installed)
az servicebus queue show --name orders \
  --namespace-name anyq-namespace \
  --connection-string "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true"
```

### High Resource Usage

The emulator is resource-intensive. Consider:

1. Increase Docker memory limit to at least 4GB
2. Use real Azure Service Bus for production testing
3. Stop the emulator when not in use

### Queue Not Found

Check the Config.json file is mounted correctly:

```bash
# Verify config is mounted
docker exec anyq-servicebus cat /ServiceBus_Emulator/ConfigFiles/Config.json
```

## Alternative: Use Real Azure (Free Tier)

For a lighter development experience, consider using Azure Service Bus Basic tier:

- First 13M operations/month free
- No emulator overhead
- Same API as production

```bash
# Create free-tier namespace
az servicebus namespace create \
  --name anyq-dev-free \
  --resource-group your-rg \
  --sku Basic
```
