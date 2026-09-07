# pgmq Tester

Test application for the `@anyq/pgmq` adapter against a local Postgres with pgmq.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Docker](https://www.docker.com/) and Docker Compose

## Quick start

```bash
cd apps/testers/pgmq
bun run docker:up      # starts quay.io/tembo/pg17-pgmq on localhost:5432
bun run dev            # http://localhost:3000
```

The adapter creates the `orders` and `orders_dlq` queues on connect.

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Producer and consumer health, including queue depth |
| `/publish` | POST | Publish one order (JSON body) |
| `/publish/batch` | POST | Publish an array of orders |
| `/publish/test` | POST | Publish a random order |
| `/stats` | GET | Counters |
| `/stats/messages` | GET | Recently consumed messages |

## Environment

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `PGMQ_URL` | `postgres://postgres:postgres@localhost:5432/postgres` |
| `PGMQ_QUEUE` | `orders` |
