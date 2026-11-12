import type { CheckoutPayment } from '../../domain/conversation/types.js';

export type CreateCheckoutPaymentInput = {
  orderId: string;
  amount: string;
};

export type CheckoutPayments = {
  createPayment(input: CreateCheckoutPaymentInput): Promise<CheckoutPayment>;
  readPayment(paymentId: string): Promise<CheckoutPayment>;
  markFulfilled(paymentId: string): Promise<void>;
};
