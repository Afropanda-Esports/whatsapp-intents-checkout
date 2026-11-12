import type { MerchantOrder } from '../domain/conversation/types.js';
import type { MerchantOrders } from '../ports/outbound/merchant-orders.js';

export const PSN_VOUCHER = 'VOUCHER-PSN-10';

export type OrderRow = {
  id: string;
  sku: string;
  conversationId: string;
  fulfilled: boolean;
};

export type InMemoryOrders = MerchantOrders & {
  rows: OrderRow[];
};

export function createInMemoryOrders(trace: string[]): InMemoryOrders {
  const rows: OrderRow[] = [];
  return {
    rows,
    async createOrder(input) {
      const existing = rows.find((row) => row.conversationId === input.conversationId && row.sku === input.sku);
      if (existing !== undefined) return toOrder(existing);
      const row: OrderRow = {
        id: `ord-${rows.length + 1}`,
        sku: input.sku,
        conversationId: input.conversationId,
        fulfilled: false,
      };
      rows.push(row);
      trace.push('create_order');
      return toOrder(row);
    },
    async markFulfilled(orderId) {
      const row = rows.find((item) => item.id === orderId);
      if (row === undefined) throw new Error('order not found');
      row.fulfilled = true;
      trace.push('mark_order_fulfilled');
    },
    async readVoucher(orderId) {
      const row = rows.find((item) => item.id === orderId);
      trace.push('read_voucher');
      if (row === undefined || !row.fulfilled || row.sku !== 'psn-10') return null;
      return PSN_VOUCHER;
    },
  };
}

function toOrder(row: OrderRow): MerchantOrder {
  return { id: row.id, sku: row.sku, conversationId: row.conversationId };
}
