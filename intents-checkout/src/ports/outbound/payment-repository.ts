import type { NewPayment, Payment } from '../../domain/payment/types.js';

export type InsertPaymentResult = { status: 'inserted'; payment: Payment } | { status: 'duplicate' };

export type PaymentRepository = {
  findById(merchantId: string, paymentId: string): Promise<Payment | undefined>;
  findByMerchantOrder(merchantId: string, merchantOrderId: string): Promise<Payment | undefined>;
  /** Inserts the payment and its first payment_events row in one transaction. */
  insertWithEvent(payment: NewPayment): Promise<InsertPaymentResult>;
};
