# anyq (Go)

A Go port of [anyq](../README.md), a universal message queue abstraction. One
small set of interfaces (`Producer`, `Consumer`, `Message`, `Strategy`) over ten
brokers, with pluggable message retry strategies that behave consistently
across every adapter.

This is a faithful behavioral port of the TypeScript implementation under
[`packages/`](../packages); the TypeScript code remains the source of truth.

- **Module path:** `github.com/sns45/anyq/go`
- **Go:** 1.25+
- **Version:** 0.4.0 (matches the TS numbering; retry strategies included from the first Go release)

## Install

```bash
go get github.com/sns45/anyq/go@latest
```

You only pull in the broker clients you actually import. `core` has zero broker
SDK dependencies, so importing `github.com/sns45/anyq/go/nats` never drags in the
Kafka client, and vice versa.

## Layout

```
go/
  core/             interfaces, errors, retry strategies, backoff, serialization (no broker SDKs)
  memory/  redis/  rabbitmq/  sqs/  sns/  pubsub/  kafka/  nats/  azureservicebus/  pgmq/
  apps/testers/     one runnable integration-test server per adapter (net/http stdlib)
```

## Quick start

```go
package main

import (
	"context"
	"log"

	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

func main() {
	ctx := context.Background()
	cfg := memory.Config{QueueName: "orders"}

	producer := memory.NewProducer(cfg)
	consumer := memory.NewConsumer(cfg)
	_ = producer.Connect(ctx)
	_ = consumer.Connect(ctx)

	go consumer.Subscribe(ctx, func(ctx context.Context, msg core.Message) error {
		log.Printf("received %s: %s", msg.ID(), msg.Body())
		return nil // returning nil auto-acks
	}, nil)

	_, _ = producer.Publish(ctx, []byte(`{"orderId":"1"}`), nil)
	select {}
}
```

Swap `memory` for any other adapter package; the `core.Producer` / `core.Consumer`
surface is identical. The message body is `[]byte` at the boundary — decode it in
your handler (the `core` package ships a JSON helper: `core.UnmarshalJSON[T]`).

## Retry strategies

A `Strategy` maps a failed `(message, error, attempt)` triple to a `Decision`:
`Ack`, `Retry`, `Requeue`, `DeadLetter`, `Park`, or `Fail`. Set one on any
adapter's config; leave it `nil` to keep the adapter's legacy behavior unchanged
(fully backward compatible).

```go
cfg := memory.Config{
	QueueName: "orders",
	BaseQueueConfig: core.BaseQueueConfig{
		Strategy: core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{
			Backoff: &core.RetryConfig{InitialDelayMs: 100, MaxDelayMs: 5000, Multiplier: 2, Jitter: true},
		}),
		Retry:           &core.RetryConfig{MaxRetries: 4},          // maxAttempts = 5
		DeadLetterQueue: &core.DeadLetterConfig{Enabled: true, MaxDeliveryAttempts: 5},
	},
}
```

Built-in strategy factories (in `core`):

| Factory | Behavior |
|---|---|
| `RetryThenDeadLetter(opts)` | in-process retry with backoff while retryable & attempts remain, else dead-letter (reference strategy) |
| `LogAndSkip()` | ack and drop |
| `LogAndFail()` | rethrow; crash the consume loop |
| `DeadLetterImmediate()` | straight to DLQ, no retry (poison messages) |
| `BackpressurePause(opts)` | on rate/quota errors, park *and* pause/resume the whole consumer; else requeue |
| `Custom(name, fn)` | wrap an arbitrary decision function |

All handler-error handling is centralized in `core.BaseConsumer.ApplyStrategy`, so
every adapter honors strategies identically. The decision flow:

- **Ack** → `msg.Ack()` · **Requeue** → `msg.Nack(true)` · **Fail** → return the error (stops the loop)
- **DeadLetter** → adapter dead-letter hook (default: warn + `Nack(false)`)
- **Retry** → sleep `DelayMs` (context-cancellable), re-invoke the handler in-process; dead-letter on exhaustion
- **Park** → native delayed redelivery where supported; otherwise **downgrade to in-process retry with a warning** (never throws)

`maxAttempts` resolves as: `DeadLetterQueue.MaxDeliveryAttempts` → `Retry.MaxRetries+1` →
default (`3+1`). A strategy-level `MaxAttempts` option overrides it.

### Park downgrade policy (`AllowParkDowngrade`)

On adapters without native delay, a `park` decision downgrades to a *blocking
in-process retry*, which can stall the consumer and, on lease-based brokers,
duplicate the message when the lock/visibility window expires mid-sleep. To make
this loud instead of silent, consumer construction runs a startup check:

- If the configured strategy **might emit `park`** (anything except the
  provably-park-free built-ins `LogAndSkip`, `LogAndFail`, `DeadLetterImmediate`,
  `RetryThenDeadLetter`) **and** the adapter has no native delay, then:
  - `AllowParkDowngrade == false` (the **default** for this module — fail loud):
    `Connect` returns a `ConfigurationError`.
  - `AllowParkDowngrade == true`: the downgrade is allowed and logged once.

```go
cfg := redis.Config{ /* ... */ }
cfg.Strategy = core.BackpressurePause(nil)   // might park
cfg.AllowParkDowngrade = true                // opt into the in-process downgrade on a non-native broker
```

The Go default is fail-loud because the Go module has no tagged release yet; the
TypeScript port defaults to *downgrade-allowed* to preserve behavior for its
already-published packages.

> The circuit breaker in `BaseAdapter` handles connection/transport failure;
> retry strategies handle per-message handler failure. The two are independent —
> strategies never trip the breaker.

## Adapters & capability matrix

The retry-strategy abstraction is uniform across adapters, but the *physical
execution* of two decisions — `park` and `deadLetter` — depends on broker
support. Read the two columns below as guarantees:

**`park` (scheduled retry)** needs a native broker delay primitive. Where one
exists, the message is handed back to the broker to redeliver after the delay (it
survives a consumer restart and doesn't block the consumer). Where it doesn't,
`park` **downgrades to a blocking in-process retry** capped by `maxAttempts`. The
downgrade is gated by `AllowParkDowngrade` (see Retry strategies) and, when
allowed, logged once at startup.

**`deadLetter`** guarantees **"stop redelivering" universally**, but **"lands in a
DLQ" only where marked**. It actively routes to a DLQ via the adapter hook only in
`memory` and `pgmq`; elsewhere a `deadLetter` decision settles the message (so it stops being
redelivered) and relies on **broker-native policy you configure out-of-band**
(SQS redrive, RabbitMQ DLX, NATS `MaxDeliver`, ASB dead-letter sub-queue) to do
the actual DLQ-ing. On adapters with no such config, a `deadLetter` decision
simply drops the message.

| Adapter | Package | Client library | Native `park` delay | `deadLetter` lands in DLQ |
|---|---|---|---|---|
| Memory | `memory` | (none) | ✅ timer re-enqueue | ✅ via hook (native DLQ) |
| Postgres (pgmq) | `pgmq` | `jackc/pgx/v5` with `pgxpool` | ✅ `set_vt` | ✅ transactional send to DLQ and delete original |
| Redis Streams | `redis` | `redis/go-redis/v9` | ⬇️ downgrade | ⚠️ drop (XACK; no broker DLQ) |
| RabbitMQ | `rabbitmq` | `rabbitmq/amqp091-go` | ⬇️ downgrade | ◐ broker DLX (if declared) |
| AWS SQS | `sqs` | `aws/aws-sdk-go-v2` | ✅ `DelaySeconds` (0–900) | ◐ broker redrive (if configured) |
| AWS SNS | `sns` | `aws/aws-sdk-go-v2` | n/a (publish-only) | n/a |
| Google Pub/Sub | `pubsub` | `cloud.google.com/go/pubsub` (v1) | ⬇️ downgrade (native deferred — needs external scheduler) | ◐ broker policy (if configured) |
| Kafka | `kafka` | `segmentio/kafka-go` | ⬇️ downgrade (native deferred — retry topics) | ⚠️ drop (`<topic>.dlq` deferred) |
| NATS JetStream | `nats` | `nats-io/nats.go` | ✅ `NakWithDelay` | ◐ broker `MaxDeliver` (if configured) |
| Azure Service Bus | `azureservicebus` | `Azure/azure-sdk-for-go/.../azservicebus` | ✅ `ScheduledEnqueueTime` (re-send + complete) | ◐ broker sub-queue (after MaxDeliveryCount) |

Legend — park: ✅ native · ⬇️ downgrades to in-process retry. dead-letter: ✅ routed
by the adapter hook · ◐ stop-redelivering + broker-native DLQ if you configured it
· ⚠️ stop-redelivering only (dropped) unless you add broker DLQ infra.

SNS is publish-only and has no consumer or retry-strategy surface.

> **Why `pubsub` is downgrade, not native:** Pub/Sub has no per-message
> "redeliver after N seconds" primitive. A real native park needs external infra
> (Cloud Tasks, or a dedicated delay topic + a mover), so it's grouped with
> kafka/rabbitmq/redis as deferred rather than implemented as a half-measure.

## Differences from the TypeScript design (idiomatic Go)

- **Errors, not exceptions.** Every method returns `error`. `Strategy.Decide` returns `(Decision, error)`.
- **`context.Context` everywhere** replaces the TS `AbortSignal`; cancelling the context stops a `Subscribe` loop.
- **`[]byte` bodies** at the interface boundary instead of a generic `T` — serialization is an opt-in `core` helper, not baked into every interface, so embedding and adapter code stays simple.
- **`OnError` callback** on the config replaces the TS consumer `error` event emitter.
- **Go has no method overriding**, so adapters embed `*core.BaseConsumer`, call `Bind(self)`, and override the `ConsumerHooks` (`SupportsNativeDelay`, `DeadLetterMessage`, `ParkMessage`) the shared `ApplyStrategy` dispatches to.
- Optional capabilities (`Seek`, `GetLag`, `ExtendDeadline`) are small interfaces / return `core.ErrNotSupported` rather than optional members.

## Integration test servers

Each adapter has a runnable server under `apps/testers/<adapter>/` exposing the
same endpoints as the TS testers: `GET /`, `GET /health` (+ `/ready`, `/live`),
`POST /publish`, `POST /publish/batch`, `POST /publish/test`, `GET /stats`,
`GET /stats/messages`. They use only the `net/http` standard library.

Memory needs no broker:

```bash
cd go && PORT=3000 QUEUE_NAME=orders go run ./apps/testers/memory
curl -XPOST localhost:3000/publish/test
curl localhost:3000/stats
```

Broker-backed adapters reuse the existing docker-compose files:

```bash
cd go/apps/testers/redis-streams
docker compose up -d
REDIS_ADDR=localhost:6379 go run .   # in another shell, then POST /publish/test
```

## Testing

```bash
cd go
go test ./...                 # unit tests (core strategies + memory E2E), no broker needed
go test -race ./...           # same, with the race detector
go vet -tags integration ./...# compile the broker-backed integration tests
```

Integration tests are guarded by `//go:build integration` and self-skip unless
their broker env var is set (e.g. `REDIS_ADDR`, `RABBITMQ_URL`, `KAFKA_BROKERS`,
`NATS_URL`, `SQS_ENDPOINT`, `PGMQ_URL`, `PUBSUB_EMULATOR_HOST`,
`AZURE_SERVICEBUS_CONNECTION_STRING`). Bring up the matching `docker compose`,
export the var, and run `go test -tags integration ./<adapter>/...`.

## Postgres with pgmq

Import `github.com/sns45/anyq/go/pgmq`. Constructors return an error immediately for invalid queue names. Bodies must be valid JSON; Postgres stores them as `jsonb`, so whitespace and object key order can change. Header values must contain UTF8 text. The adapter rejects invalid UTF8 instead of replacing bytes. Headers use the `headers` column, and the reserved `x-anyq-key` header carries `PublishOptions.Key` across the Go and TypeScript adapters.

```go
cfg := pgmq.Config{
    ConnectionString: "postgres://postgres:postgres@localhost:5432/postgres",
    QueueName: "orders",
    VisibilityTimeout: 30 * time.Second,
    BaseQueueConfig: core.BaseQueueConfig{
        Strategy: core.RetryThenDeadLetter(nil),
    },
}
producer, err := pgmq.NewProducer(cfg)
if err != nil { log.Fatal(err) }
if err := producer.Connect(ctx); err != nil { log.Fatal(err) }
consumer, err := pgmq.NewConsumer(cfg)
if err != nil { log.Fatal(err) }
if err := consumer.Connect(ctx); err != nil { log.Fatal(err) }
_, err = producer.Publish(ctx, []byte(`{"orderId":"1"}`), &core.PublishOptions{
    Key: "customer1", Delay: time.Second,
    Headers: core.MessageHeaders{"trace": []byte("request1")},
})
if err != nil { log.Fatal(err) }
```

| Config | Default | Meaning |
|---|---|---|
| `ConnectionString` | PG environment variables | Postgres connection string |
| `Pool` | nil | Optional existing `*pgxpool.Pool`; the caller owns it |
| `QueueName` | required | Must match `^[a-zA-Z0-9_]{1,47}$` |
| `DeadLetterQueue` | `<queue>_dlq` | Explicitly choose a shorter name if the default exceeds 47 characters; `BaseQueueConfig.DeadLetterQueue.Destination` is also honored |
| `VisibilityTimeout` | `30 * time.Second` | Processing lease; fractional seconds round up |
| `PollInterval` | `time.Second` | Sleep after an empty read or transport error |
| `BatchSize` | `100` | Default `SubscribeBatch` size; subscription options may override it |
| `AutoCreate` | nil (true) | Creates the queue and DLQ on connect; use a pointer to false to disable |
| `AutoInstall` | nil (true) | Attempts `CREATE EXTENSION IF NOT EXISTS pgmq` only when the schema is absent |

`SubscribeOptions.Concurrency` controls workers; each worker reads one lease when ready for its next message. The consumer uses `pgmq.read`, followed by `PollInterval` when the queue is empty. Pausing, cancelling, or disconnecting releases unread handler deliveries with `set_vt 0`. An active database read can take up to `RequestTimeout` to finish and release its result. Disconnect stops new operations immediately and closes an owned pool after active operations finish. A supplied pool stays open.

`Ack` deletes; `Nack(true)` makes the same message visible immediately; `Nack(false)` archives it. Explicit settlement wins over automatic acknowledgement. `ExtendDeadline` sets the lease relative to now and rounds up fractional seconds. `DeliveryAttempt` comes from `read_ct`; message IDs remain decimal strings with an internal `int64`. `Raw()` returns a `pgmq.Record` and `Metadata().Pgmq` carries the queue, ID, read count and timestamps. Health checks query `pgmq.metrics` and report `queueLength` and `totalMessages`.

Native park uses `set_vt` and preserves the message ID. A dead letter decision sends to the configured DLQ and deletes the source in one transaction. If sending fails or the source is already gone, no new DLQ copy commits. The original headers remain, with `x-original-queue`, `x-death-time`, `x-delivery-attempts` and `x-death-reason` added. The attempts header records the native read count, including when a strategy retries the handler in process. Supplying a `BaseQueueConfig.DeadLetterQueue` with `IncludeError: false` omits the reason.

pgmq settlement identifies a message by ID, without a receipt token for each lease. Keep handlers idempotent and extend the lease before it expires; a stale handler must not settle a message already claimed by another consumer. JSON storage does not support arbitrary binary bodies or binary header values.

Connecting without pgmq returns an error naming the SQL only install path `pgmq-extension/sql/pgmq.sql`. The adapter accepts a SQL only installation by detecting `pgmq.read`, without requiring a `pg_extension` entry.

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


The tester exposes the same HTTP endpoints as the other Go testers:

```bash
PGMQ_URL=postgres://postgres:postgres@localhost:5433/postgres go run ./apps/testers/pgmq
PGMQ_URL=postgres://postgres:postgres@localhost:5433/postgres go test -race -tags integration ./pgmq -count=1 -v
```

Run those commands from `go/`. The supplied `apps/testers/pgmq/docker-compose.yml` binds port 5432 for a standalone local database. Integration tests use unique `go_` queue names and skip unless `PGMQ_URL` is set.

## Known gaps / follow-ups

- **Kafka:** native retry-topic / `<topic>.dlq` delay machinery is deferred (matches TS 0.3.0). SASL PLAIN + TLS are wired; SCRAM is not yet enabled.
- **Pub/Sub & Azure Service Bus:** native consumer-side `park` (re-publish-with-delay / `scheduledEnqueueTimeUtc`) is deferred; `park` downgrades to in-process retry, matching shipped TS.
- **Pub/Sub** uses the v1 client (`cloud.google.com/go/pubsub`) for a cleaner emulator/ensure-resource path.

## Versioning & release tags

This module lives in the `go/` subdirectory of a polyglot repo, so its semver
tags are **prefixed with the subdirectory**:

```
go/v0.4.0
```

Consumers resolve it transparently: `go get github.com/sns45/anyq/go@v0.4.0`
selects the `go/v0.4.0` tag because the module path ends in `/go`. Keep the Go
version number aligned with the TypeScript package version where practical.

## License

Apache License 2.0. See [LICENSE](https://github.com/sns45/anyq/blob/main/LICENSE).
