# @anyq/pgmq

Postgres adapter for [anyq](https://github.com/sns45/anyq), backed by [pgmq](https://github.com/pgmq/pgmq). Run a real queue on the database you already operate, with the same producer and consumer API as every other anyq driver.

## Install

```bash
bun add @anyq/core @anyq/pgmq
```

pgmq must be present in the target database. The adapter runs `CREATE EXTENSION IF NOT EXISTS pgmq` on connect when the `pgmq` schema is missing (set `autoInstall: false` to disable). Where you cannot create extensions, use pgmq's SQL only install:

```bash
psql -f pgmq-extension/sql/pgmq.sql postgres://user:pass@host:5432/db
```

### Managed Postgres: check the extension allowlist first

As of Sept 7, 2026, `pgmq` is not on the extension allowlist of the managed services below, so `CREATE EXTENSION pgmq` is refused there and the adapter's `autoInstall` fails with a `ConfigurationError`. Skype's `pgq` is absent from the same lists.

| Service | Checked against | pgmq listed? |
|---|---|---|
| Amazon RDS for PostgreSQL | [Extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html), PostgreSQL 9.6 to 19 | No |
| Amazon Aurora PostgreSQL | [Extensions supported](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html), PostgreSQL 10 to 18 | No |
| Azure Database for PostgreSQL flexible server | [Extensions by name](https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions), article dated 2026-07-10 | No |
| Google Cloud SQL for PostgreSQL | [Configure extensions](https://docs.cloud.google.com/sql/docs/postgres/extensions), updated 2026-08-28 | No |
| Google AlloyDB | [Supported extensions](https://docs.cloud.google.com/alloydb/docs/reference/extensions), updated 2026-08-26 | No |
| Neon | [Postgres extensions](https://neon.com/docs/extensions/pg-extensions) | No |
| Supabase | [Supabase Queues](https://supabase.com/docs/guides/queues) | Yes, Supabase Queues is built on pgmq |

On the services that do not list it, pgmq documents a SQL only install for exactly this case: pgmq 1.x is plain SQL and PL/pgSQL, so `psql -f pgmq-extension/sql/pgmq.sql <url>` creates the `pgmq` schema without extension privileges. Run that as the database owner, then connect with `autoInstall: false`. This adapter detects a SQL only install (it looks for `pgmq.read`, not for an extension row). The SQL only path has not been verified on those services by this project, and allowlists change, so check the vendor page before relying on this note.

For local work the pgmq project publishes a Postgres image:

```bash
docker run -d --name pgmq -e POSTGRES_PASSWORD=postgres -p 5432:5432 quay.io/tembo/pg17-pgmq:latest
```

## Quick start

```typescript
import { createPgmqProducer, createPgmqConsumer } from '@anyq/pgmq';

const pg = { connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' };

const producer = createPgmqProducer<{ orderId: string }>({ queueName: 'orders', pg });
const consumer = createPgmqConsumer<{ orderId: string }>({
  queueName: 'orders',
  pg,
  consumer: { visibilityTimeout: 30 },
  deadLetterQueue: { enabled: true, destination: 'orders_dlq', maxDeliveryAttempts: 3, includeError: true },
});

await producer.connect();
await consumer.connect();

await consumer.subscribe(async (message) => {
  console.log(message.body, 'attempt', message.deliveryAttempt);
  await message.ack();
});

await producer.publish({ orderId: '123' });
await producer.publish({ orderId: '124' }, { delaySeconds: 60 });
```

## How it maps onto pgmq

| anyq | pgmq |
|---|---|
| `publish` with `delaySeconds` | `pgmq.send(queue, msg, headers, delay)` |
| `publishBatch` | `pgmq.send_batch` (one call per distinct delay) |
| poll | `pgmq.read_with_poll(queue, vt, qty, ...)`, falling back to `pgmq.read` |
| `ack()` | `pgmq.delete` |
| `nack(true)` | `pgmq.set_vt(queue, id, 0)`: visible again at once |
| `nack(false)` | `pgmq.archive`: kept in `pgmq.a_<queue>`, never silently dropped |
| `extendDeadline(seconds)` | `pgmq.set_vt(queue, id, seconds)` (absolute from now, like SQS) |
| `deliveryAttempt` | `read_ct` |
| `park` (retry strategies) | `pgmq.set_vt(queue, id, delay)`, native, no in process downgrade |
| dead letter | `pgmq.send` to the DLQ queue, then `pgmq.delete` the original |

Headers travel in pgmq's `headers` jsonb column; the routing `key` is stored there under the reserved header `x-anyq-key`. Dead lettered messages carry `x-original-queue`, `x-death-time`, `x-delivery-attempts` and, unless `includeError` is false, `x-death-reason`.

The visibility timeout is the processing lease. A message that is neither acked nor nacked becomes visible again when `vt` lapses, with `read_ct` incremented, so `deliveryAttempt` is always truthful.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `queueName` | required | Must match `^[a-zA-Z0-9_]{1,47}$` (pgmq limit) |
| `pg.connectionString` | | Or `host`, `port`, `user`, `password`, `database`, `ssl`, `max` |
| `pool` | | Reuse an existing `pg.Pool`; the adapter will not end it |
| `autoCreate` | `true` | `pgmq.create` for the queue and DLQ on connect |
| `autoInstall` | `true` | `CREATE EXTENSION IF NOT EXISTS pgmq` when the schema is missing |
| `producer.delaySeconds` | `0` | Default delay when `PublishOptions.delaySeconds` is absent |
| `consumer.visibilityTimeout` | `30` | Seconds a read message stays invisible |
| `consumer.longPollSeconds` | `5` | Server side wait via `read_with_poll`; `0` uses `read` plus `pollingInterval` |
| `consumer.longPollIntervalMs` | `100` | Check interval inside a long poll |
| `consumer.pollingInterval` | `1000` | Sleep in ms when the queue is empty and long polling is off |
| `consumer.maxMessages` | `100` | Upper bound per read |
| `deadLetterQueue` | disabled | `destination` defaults to `<queueName>_dlq` when enabled |

`healthCheck()` reports round trip latency plus `queueLength` and `totalMessages` from `pgmq.metrics`.

## Retry strategies

All `@anyq/core` strategies work end to end. `park` decisions (for example from `backpressurePause`) are scheduled natively through `set_vt`, so the consumer never blocks in process and no downgrade warning is logged at startup. Without a strategy, a failing handler leaves the message to reappear after the visibility timeout, and the adapter dead letters it once `deadLetterQueue.maxDeliveryAttempts` is reached.

## Tests

The integration suite needs a pgmq Postgres and skips itself otherwise:

```bash
docker run -d --name pgmq -e POSTGRES_PASSWORD=postgres -p 5433:5432 quay.io/tembo/pg17-pgmq:latest
PGMQ_URL=postgres://postgres:postgres@localhost:5433/postgres bun test
```

## License

Apache License 2.0. See [LICENSE](https://github.com/sns45/anyq/blob/main/LICENSE).
