/**
 * Azure Service Bus Tester Configuration
 */

// Emulator connection string
const EMULATOR_CONNECTION_STRING = 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  servicebus: {
    connectionString: process.env.SERVICEBUS_CONNECTION_STRING ?? EMULATOR_CONNECTION_STRING,
    queue: process.env.SERVICEBUS_QUEUE ?? 'orders',
  },
} as const;
