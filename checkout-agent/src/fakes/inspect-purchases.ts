import type { InMemoryCheckout } from './in-memory-checkout.js';
import type { InMemoryOrders } from './in-memory-orders.js';

export type PurchaseInspection = {
  trace: string[];
  ordersFor(conversationId: string): number;
  paymentsFor(conversationId: string): number;
  statusFor(conversationId: string): string | undefined;
  depositAddressFor(conversationId: string): string | undefined;
};

export function inspectPurchases(orders: InMemoryOrders, checkout: InMemoryCheckout, trace: string[]): PurchaseInspection {
  return {
    trace,
    ordersFor(conversationId) {
      return orders.rows.filter((row) => row.conversationId === conversationId).length;
    },
    paymentsFor(conversationId) {
      const orderIds = new Set(orders.rows.filter((row) => row.conversationId === conversationId).map((row) => row.id));
      return checkout.rows.filter((row) => orderIds.has(row.payment.orderId)).length;
    },
    statusFor(conversationId) {
      return paymentFor(orders, checkout, conversationId)?.status;
    },
    depositAddressFor(conversationId) {
      return paymentFor(orders, checkout, conversationId)?.depositAddress;
    },
  };
}

function paymentFor(orders: InMemoryOrders, checkout: InMemoryCheckout, conversationId: string) {
  const order = orders.rows.find((row) => row.conversationId === conversationId);
  if (order === undefined) return undefined;
  return checkout.rows.find((row) => row.payment.orderId === order.id)?.payment;
}
