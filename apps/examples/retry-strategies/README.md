# @anyq/example-retry-strategies

Runnable examples of the pluggable retry strategies introduced in `@anyq/core@0.3.0`,
paired with **unit** and **integration** tests that exercise each strategy end-to-end.

## Layout

```
src/
├── examples/                  # one strategy per file (adapter-agnostic)
│   ├── log-and-skip.ts
│   ├── log-and-fail.ts
│   ├── retry-then-dead-letter.ts
│   ├── dead-letter-immediate.ts
│   ├── backpressure-pause.ts
│   ├── custom.ts
│   ├── shared.ts              # ExampleResult, AdapterFactory, memoryAdapter
│   └── index.ts
├── adapters/                  # broker factories used by integration tests
│   ├── redis-streams.ts
│   ├── rabbitmq.ts
│   ├── nats.ts
│   ├── kafka.ts
│   ├── reachable.ts           # TCP probe used to gate broker suites
│   └── index.ts
└── index.ts                   # CLI runner

test/
├── unit/
│   └── examples.test.ts       # strategy wiring contract (no adapter)
└── integration/
    ├── suite.ts               # parameterised assertions
    ├── memory.test.ts         # always runs
    ├── redis-streams.test.ts  # skips if 127.0.0.1:6379 unreachable
    ├── rabbitmq.test.ts       # skips if 127.0.0.1:5672 unreachable
    ├── nats.test.ts           # skips if 127.0.0.1:4222 unreachable
    └── kafka.test.ts          # skips if 127.0.0.1:9092 unreachable
```

## Run the examples

The CLI runner takes one or more example names and an optional `--adapter=` flag.

```bash
# All examples on the in-memory adapter (default)
bun run start

# One example on a specific broker
bun run start --adapter=redis-streams retry-then-dead-letter
bun run start --adapter=rabbitmq backpressure-pause
bun run start --adapter=nats deadLetter-immediate
bun run start --adapter=kafka log-and-skip
```

For broker adapters, start the relevant docker-compose stack first, e.g.

```bash
docker-compose -f apps/testers/redis-streams/docker-compose.yml up redis
```

## Run the tests

```bash
bun test               # everything
bun run test:unit      # adapter-agnostic strategy assertions
bun run test:integration  # memory always; brokers if reachable
```

Each broker integration file probes its broker via TCP in `beforeAll` and
no-ops the cases when the broker isn't reachable, so the suite is safe to
run in any environment.
