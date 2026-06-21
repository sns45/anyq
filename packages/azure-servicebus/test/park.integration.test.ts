/**
 * @fileoverview Azure Service Bus native-park integration test.
 *
 * Runs against a live Azure Service Bus emulator (or a real namespace). It is
 * SKIPPED unless AZURE_SERVICEBUS_CONNECTION_STRING is set, mirroring the Go
 * port's integration gating (a separate orchestrator brings up the emulator and
 * runs this; it is not started here).
 *
 * Bring up the emulator with:
 *
 *   cd apps/testers/azure-servicebus && docker compose up -d
 *
 * then run:
 *
 *   AZURE_SERVICEBUS_CONNECTION_STRING='Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true' \
 *     bun test packages/azure-servicebus/test/park.integration.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { custom, type IMessage } from '@anyq/core';
import {
  ServiceBusProducer,
  ServiceBusConsumer,
} from '../src/index.js';
import type { ServiceBusConsumerConfig, ServiceBusProducerConfig } from '../src/config.js';

const CONNECTION_STRING = process.env.AZURE_SERVICEBUS_CONNECTION_STRING ?? '';
const QUEUE_NAME = process.env.AZURE_SERVICEBUS_QUEUE ?? 'anyq-it';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(CONNECTION_STRING === '')('Azure Service Bus native park', () => {
  test(
    'park is broker-mediated: parked message reappears on a fresh consumer only after the delay',
    async () => {
      const parkDelayMs = 8000;

      const producerConfig: ServiceBusProducerConfig = {
        clientId: 'azure-servicebus-it',
        connection: { connectionString: CONNECTION_STRING },
        queue: { name: QUEUE_NAME },
      };

      // Always park on failure (native, since the ASB consumer supports delay).
      const consumerAConfig: ServiceBusConsumerConfig = {
        clientId: 'azure-servicebus-it',
        connection: { connectionString: CONNECTION_STRING },
        queue: { name: QUEUE_NAME },
        strategy: custom('park-always', () => ({
          action: 'park',
          delayMs: parkDelayMs,
        })),
      };

      const producer = new ServiceBusProducer(producerConfig);
      await producer.connect();

      const consumerA = new ServiceBusConsumer(consumerAConfig);
      await consumerA.connect();

      // Consumer B: a fresh consumer, NO strategy, just records the arrival time.
      const consumerBConfig: ServiceBusConsumerConfig = {
        clientId: 'azure-servicebus-it',
        connection: { connectionString: CONNECTION_STRING },
        queue: { name: QUEUE_NAME },
      };
      const consumerB = new ServiceBusConsumer(consumerBConfig);
      await consumerB.connect();

      try {
        await producer.publish(
          { orderId: 'IT-PARK' },
          { key: 'IT-PARK' },
        );

        // Consumer A: receive once, fail (-> native park), then disconnect so no
        // in-process timer of A's can possibly redeliver.
        let firstSeenResolve: () => void;
        const firstSeen = new Promise<void>((resolve) => {
          firstSeenResolve = resolve;
        });
        await consumerA.subscribe(async (_message: IMessage) => {
          firstSeenResolve();
          throw new Error('force a park');
        });

        await firstSeen;
        const parkedAt = Date.now();

        // Grace period so parkMessage (scheduled re-send + complete original)
        // finishes, then fully disconnect A.
        await sleep(2000);
        await consumerA.disconnect();

        // Consumer B records when (if) the parked message reappears.
        let gotAtResolve: (when: number) => void;
        const gotAt = new Promise<number>((resolve) => {
          gotAtResolve = resolve;
        });
        await consumerB.subscribe(async (message: IMessage) => {
          gotAtResolve(Date.now());
          await message.ack();
        });

        const reappearedAt = await Promise.race([
          gotAt,
          sleep(30000).then(() => -1),
        ]);

        expect(reappearedAt).toBeGreaterThan(0);
        const elapsed = reappearedAt - parkedAt;

        // Broker-mediated: the message reappears only after (nearly) the full
        // delay, on a consumer that did not exist when the park happened. Allow
        // scheduling slack but require clearly more than the 2s grace, proving
        // it was the broker's scheduled enqueue and not an immediate redelivery.
        expect(elapsed).toBeGreaterThanOrEqual(parkDelayMs - 2000);
      } finally {
        await consumerA.disconnect().catch(() => undefined);
        await consumerB.disconnect();
        await producer.disconnect();
      }
    },
    60000,
  );
});
