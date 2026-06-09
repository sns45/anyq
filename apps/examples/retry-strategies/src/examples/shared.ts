/**
 * Shared helpers for retry strategy examples.
 *
 * Each example exports:
 *  - `strategy`: the configured `RetryStrategy` instance the example uses
 *    (so unit tests can probe its `.name` and `.decide()` without spinning
 *    up a consumer).
 *  - `run(...)`: an end-to-end demo against a producer/consumer pair that
 *    publishes messages, runs a handler, waits for the strategy to settle,
 *    and returns a snapshot of what happened.
 *
 * `run(...)` defaults to the in-memory adapter (zero infra) but accepts
 * an `adapter` option so the same example can be exercised against any
 * adapter without changing example or test code.
 */

import type {
  BaseRetryStrategy,
  IProducer,
  IConsumer,
} from '@anyq/core';
import { MemoryProducer, MemoryConsumer, clearAllQueues } from '@anyq/memory';
import type { MemoryQueueConfig } from '@anyq/memory';

export interface ExampleResult {
  /** Strategy name (matches `strategy.name`). */
  strategy: string;
  /** How many times the user handler was invoked. */
  handlerInvocations: number;
  /** True if the consumer was paused when the run ended. */
  consumerPausedAtEnd: boolean;
  /** Adapter-supplied counts (memory exposes these; brokers do not). */
  mainQueueSize?: number;
  deadLetterSize?: number;
}

/**
 * Adapter factory injected by integration tests so the same example runs
 * against any adapter. Each call to `create` returns a fresh producer +
 * consumer wired against the same logical queue/stream/topic + strategy.
 */
export interface AdapterFactory {
  /** Stable, human-readable adapter name (e.g. "memory", "redis-streams"). */
  name: string;
  /**
   * Build producer/consumer wired to `topic` with `strategy` configured.
   *
   * Implementations MUST configure dead-letter behaviour where the broker
   * supports it so deadLetterSize tracking can be exercised.
   */
  create(
    topic: string,
    strategy: BaseRetryStrategy,
  ): Promise<{
    producer: IProducer<{ id: string; n: number }>;
    consumer: IConsumer<{ id: string; n: number }>;
    /** Optional snapshot of broker-side counts after the run. */
    snapshot?: () => {
      mainQueueSize?: number;
      deadLetterSize?: number;
    };
    /** Per-run cleanup (clear in-memory registry, purge queue, etc.). */
    cleanup?: () => Promise<void>;
  }>;
}

export interface ExampleOptions {
  /** Adapter factory. Defaults to in-memory. */
  adapter?: AdapterFactory;
  /** Number of messages to publish. Default: 1. */
  messageCount?: number;
  /**
   * Handler implementation. Default: a handler that always throws
   * `new Error('ECONNRESET transient failure')`.
   */
  handler?: (body: { id: string; n: number }) => Promise<void>;
  /**
   * How long to wait after publishing before snapshotting state.
   * Default: 250ms.
   */
  settleMs?: number;
  /** Topic/queue/stream name. Each example uses its own default. */
  topic?: string;
  /**
   * Optional predicate consulted while polling the consumer state. When
   * provided, `runExample` polls every 25ms and snapshots as soon as the
   * predicate returns true OR `settleMs` elapses — whichever comes first.
   *
   * Use this for assertions that need to catch a transient state (e.g.
   * "consumer paused mid-flight") on slow brokers where a fixed sleep
   * either fires before the broker delivers the first message or after
   * the state has unwound.
   *
   * The predicate receives both the current handler-invocation count and
   * the consumer instance so callers can poll on broker state (e.g.
   * `consumer.isPaused()`) rather than just delivery counts.
   */
  snapshotWhen?: (
    currentInvocations: number,
    consumer: IConsumer<{ id: string; n: number }>,
  ) => boolean;
}

const RETRYABLE_DEFAULT = async (): Promise<void> => {
  throw new Error('ECONNRESET transient failure');
};

/**
 * Default in-memory adapter factory. Used when no `adapter` option is
 * supplied. Configures the standard DLQ shape so `deadLetterSize` tracking
 * works out of the box.
 */
export const memoryAdapter: AdapterFactory = {
  name: 'memory',
  async create(topic, strategy) {
    const config: MemoryQueueConfig = {
      driver: 'memory',
      queueName: topic,
      deadLetterQueue: {
        enabled: true,
        destination: `${topic}-dlq`,
        maxDeliveryAttempts: 3,
        includeError: true,
      },
      strategy,
    };
    clearAllQueues();
    const producer = new MemoryProducer<{ id: string; n: number }>(config);
    const consumer = new MemoryConsumer<{ id: string; n: number }>(config);
    return {
      producer,
      consumer,
      snapshot: () => ({
        mainQueueSize: consumer.getQueue()?.size() ?? 0,
        deadLetterSize: consumer.getDLQ()?.size() ?? 0,
      }),
      cleanup: async () => {
        clearAllQueues();
      },
    };
  },
};

/**
 * Run an example end-to-end: publish `messageCount` messages, subscribe with
 * `handler`, wait `settleMs`, snapshot, then tear down.
 */
export async function runExample(
  strategy: BaseRetryStrategy,
  defaultTopic: string,
  opts: ExampleOptions = {},
): Promise<ExampleResult> {
  const adapter = opts.adapter ?? memoryAdapter;
  const topic = opts.topic ?? defaultTopic;
  const messageCount = opts.messageCount ?? 1;
  const settleMs = opts.settleMs ?? 250;
  const handler = opts.handler ?? RETRYABLE_DEFAULT;

  const { producer, consumer, snapshot, cleanup } = await adapter.create(
    topic,
    strategy,
  );

  let invocations = 0;
  try {
    await producer.connect();
    await consumer.connect();

    // Subscribe first, then publish. Kafka consumer groups default to
    // `latest` offset reset and would miss messages published before
    // subscribe completes group join.
    await consumer.subscribe(
      async (message) => {
        invocations++;
        await handler(message.body);
      },
      { autoAck: false, fromBeginning: true },
    );

    for (let n = 0; n < messageCount; n++) {
      await producer.publish({ id: `msg-${n}`, n });
    }

    if (opts.snapshotWhen) {
      const deadline = Date.now() + settleMs;
      while (
        Date.now() < deadline &&
        !opts.snapshotWhen(invocations, consumer)
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } else {
      await new Promise((r) => setTimeout(r, settleMs));
    }

    const counts = snapshot?.() ?? {};
    return {
      strategy: strategy.name,
      handlerInvocations: invocations,
      consumerPausedAtEnd: consumer.isPaused(),
      mainQueueSize: counts.mainQueueSize,
      deadLetterSize: counts.deadLetterSize,
    };
  } finally {
    await consumer.disconnect();
    await producer.disconnect();
    if (cleanup) await cleanup();
  }
}
