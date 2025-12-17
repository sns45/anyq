/**
 * @fileoverview Type definitions for Redis Streams tester
 */

/**
 * Order message type for testing
 */
export interface OrderMessage {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  total: number;
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  price: number;
}

/**
 * Service statistics
 */
export interface ServiceStats {
  producer: {
    connected: boolean;
    messagesPublished: number;
  };
  consumer: {
    connected: boolean;
    messagesConsumed: number;
    lastMessageTime: string | null;
    paused: boolean;
  };
  redis: {
    host: string;
    stream: string;
    consumerGroup: string;
  };
}

/**
 * Consumed message record
 */
export interface ConsumedMessage {
  id: string;
  body: OrderMessage;
  receivedAt: string;
  processedAt: string;
}
