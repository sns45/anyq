/**
 * @fileoverview Type definitions for memory tester
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
  };
  queue: {
    size: number;
    processing: number;
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
