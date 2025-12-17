# @anyq/azure-servicebus

Azure Service Bus adapter for **anyq** - enterprise cloud messaging.

## Installation

```bash
npm install @anyq/azure-servicebus @anyq/core @azure/service-bus
```

## Usage

```typescript
import { AzureServiceBusProducer, AzureServiceBusConsumer } from '@anyq/azure-servicebus';

// Create producer
const producer = new AzureServiceBusProducer({
  connectionString: 'Endpoint=sb://my-namespace.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=...',
  queueName: 'my-queue'
});

// Create consumer
const consumer = new AzureServiceBusConsumer({
  connectionString: 'Endpoint=sb://my-namespace.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=...',
  queueName: 'my-queue'
});

await producer.connect();
await consumer.connect();

// Subscribe to messages
await consumer.subscribe(async (message) => {
  console.log('Received:', message.data);
  console.log('Sequence:', message.metadata.sequenceNumber);
  await message.ack();
});

// Publish messages
await producer.publish({
  event: 'invoice.created',
  invoiceId: 'INV-001'
});

// Publish with scheduling
await producer.publish(
  { reminder: 'follow-up' },
  { scheduledEnqueueTime: new Date(Date.now() + 3600000) }
);

// Cleanup
await consumer.disconnect();
await producer.disconnect();
```

## Configuration

```typescript
interface AzureServiceBusConfig {
  connectionString: string;   // Service Bus connection string
  // Queue mode
  queueName?: string;
  // Topic/subscription mode
  topicName?: string;
  subscriptionName?: string;
  // Consumer options
  maxConcurrentCalls?: number;
  autoComplete?: boolean;
  maxAutoLockRenewalDuration?: number;
  // Producer options
  enablePartitioning?: boolean;
}
```

## Features

- Queues and Topics/Subscriptions
- Scheduled messages
- Sessions (ordered processing)
- Dead letter queues
- Duplicate detection
- Auto-lock renewal
- Message deferral

## License

MIT
