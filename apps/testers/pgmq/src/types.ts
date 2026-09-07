/**
 * Message types for pgmq tester
 */

export interface Order {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  total: number;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  price: number;
}

export interface ConsumedMessage {
  id: string;
  body: Order;
  receivedAt: Date;
  deliveryAttempt: number;
  enqueuedAt?: Date;
}

export interface Stats {
  producer: {
    connected: boolean;
    publishedCount: number;
    lastPublishedAt: Date | null;
  };
  consumer: {
    connected: boolean;
    consumedCount: number;
    lastConsumedAt: Date | null;
  };
}
