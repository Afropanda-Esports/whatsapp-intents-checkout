import type { MerchantOrder } from '../../domain/conversation/types.js';

export type CreateOrderInput = {
  sku: string;
  conversationId: string;
};

export type MerchantOrders = {
  createOrder(input: CreateOrderInput): Promise<MerchantOrder>;
  markFulfilled(orderId: string): Promise<void>;
  readVoucher(orderId: string): Promise<string | null>;
};
