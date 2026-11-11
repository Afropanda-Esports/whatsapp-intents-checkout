import { DomainError } from '../domain-error.js';
import type { Payment } from './types.js';
import type { PaymentReadDeps } from './payment-service-deps.js';

export type GetPayment = {
  getPayment(merchantId: string, paymentId: string): Promise<Payment>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Reads are scoped to the merchant: another merchant's payment is simply not found. */
export function createPaymentReadService(deps: PaymentReadDeps): GetPayment {
  return {
    async getPayment(merchantId, paymentId) {
      if (!UUID.test(paymentId)) throw new DomainError('not-found');
      const payment = await deps.payments.findById(merchantId, paymentId);
      if (payment === undefined) throw new DomainError('not-found');
      return payment;
    },
  };
}
