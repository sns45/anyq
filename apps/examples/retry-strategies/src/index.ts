/**
 * CLI runner for retry-strategy examples.
 *
 * Usage:
 *   bun src/index.ts                   # runs all examples against memory
 *   bun src/index.ts retry-then-dead-letter
 *   bun src/index.ts --adapter=redis-streams retry-then-dead-letter
 *
 * The runner prints the snapshot returned by each example, which is
 * the same data the integration tests assert on.
 */

import { examples, type ExampleName } from './examples/index.js';
import type { AdapterFactory, ExampleOptions } from './examples/shared.js';
import {
  createRedisStreamsAdapter,
  createRabbitMQAdapter,
  createNatsAdapter,
  createKafkaAdapter,
} from './adapters/index.js';

const ADAPTER_FACTORIES: Record<string, () => AdapterFactory> = {
  memory: () => ({
    name: 'memory',
    // Lazy: re-exports the default memory adapter from shared.
    async create(topic, strategy) {
      const { memoryAdapter } = await import('./examples/shared.js');
      return memoryAdapter.create(topic, strategy);
    },
  }),
  'redis-streams': () => createRedisStreamsAdapter(),
  rabbitmq: () => createRabbitMQAdapter(),
  nats: () => createNatsAdapter(),
  kafka: () => createKafkaAdapter(),
};

function parseArgs(argv: string[]): {
  adapterName: string;
  selected: ExampleName[];
} {
  const args = argv.slice(2);
  let adapterName = 'memory';
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--adapter=')) {
      adapterName = arg.slice('--adapter='.length);
    } else if (arg.startsWith('--')) {
      // Unknown flag — ignore.
    } else {
      positional.push(arg);
    }
  }

  const names =
    positional.length > 0
      ? (positional as ExampleName[])
      : (Object.keys(examples) as ExampleName[]);

  return { adapterName, selected: names };
}

async function main(): Promise<void> {
  const { adapterName, selected } = parseArgs(process.argv);

  const factory = ADAPTER_FACTORIES[adapterName];
  if (!factory) {
    console.error(
      `Unknown adapter: ${adapterName}. Known: ${Object.keys(ADAPTER_FACTORIES).join(', ')}`,
    );
    process.exit(1);
  }
  const adapter = factory();

  for (const name of selected) {
    const mod = examples[name];
    if (!mod) {
      console.error(`Unknown example: ${name}`);
      continue;
    }
    const opts: ExampleOptions = { adapter };
    console.log(`\n=== ${name} on ${adapter.name} ===`);
    const result = await mod.run(opts);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
