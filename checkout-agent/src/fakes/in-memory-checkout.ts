import { isBaseUnits } from '../domain/conversation/base-units.js';
import type { CheckoutPayment } from '../domain/conversation/types.js';
import type { CheckoutPayments } from '../ports/outbound/checkout-payments.js';

export type PaymentRow = {
  payment: CheckoutPayment;
  reads: number;
};

export type InMemoryCheckout = CheckoutPayments & {
  rows: PaymentRow[];
};

export function createInMemoryCheckout(trace: string[]): InMemoryCheckout {
  const rows: PaymentRow[] = [];
  return {
    rows,
    async createPayment(input) {
      if (!isBaseUnits(input.amount)) throw new Error('amount must be base units');
      const existing = rows.find((row) => row.payment.orderId === input.orderId);
      if (existing !== undefined) return { ...existing.payment };
      const payment: CheckoutPayment = {
        id: `pay-${input.orderId}`,
        orderId: input.orderId,
        amount: input.amount,
        depositAddress: `dep-${input.orderId}`,
        status: 'AWAITING_DEPOSIT',
      };
      rows.push({ payment, reads: 0 });
      trace.push('create_payment');
      return { ...payment };
    },
    async readPayment(paymentId) {
      const row = rows.find((item) => item.payment.id === paymentId);
      if (row === undefined) throw new Error('payment not found');
      row.reads += 1;
      const status = row.reads === 1 ? 'AWAITING_DEPOSIT' : 'SETTLED';
      row.payment = { ...row.payment, status };
      trace.push('read_payment');
      return { ...row.payment };
    },
    async markFulfilled(paymentId) {
      const row = rows.find((item) => item.payment.id === paymentId);
      if (row === undefined) throw new Error('payment not found');
      trace.push('mark_payment_fulfilled');
    },
  };
}
