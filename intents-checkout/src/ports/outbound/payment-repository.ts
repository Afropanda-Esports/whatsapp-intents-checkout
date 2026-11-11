import type { WebhookEnvelope } from '../../domain/notification/webhook-body.js';
import type { NewPayment, Payment, PaymentStatusEvent } from '../../domain/payment/types.js';

export type InsertPaymentResult = { status: 'inserted'; payment: Payment } | { status: 'duplicate' };

export type { PaymentStatusEvent };

export type OutboxInsert = {
  id: string;
  type: string;
  payload: WebhookEnvelope;
};

export type PaymentRepository = {
  findById(merchantId: string, paymentId: string): Promise<Payment | undefined>;
  findByMerchantOrder(merchantId: string, merchantOrderId: string): Promise<Payment | undefined>;
  /** Inserts the payment and its first payment_events row in one transaction. */
  insertWithEvent(payment: NewPayment): Promise<InsertPaymentResult>;
  /** Payments the poller still has to watch. */
  listNonTerminal(): Promise<Payment[]>;
  /** Updates the payment, appends one payment_events row, and inserts outbox rows in one transaction. */
  updateWithEvent(payment: Payment, event: PaymentStatusEvent, outboxEvents: OutboxInsert[]): Promise<Payment>;
};
