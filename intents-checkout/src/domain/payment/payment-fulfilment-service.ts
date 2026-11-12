import { DomainError } from '../domain-error.js';
import type { PolicyLedger } from '../../ports/outbound/policy-ledger.js';
import type { Payment } from './types.js';

export type PaymentFulfilment = {
  fulfil(merchantId: string, paymentId: string): Promise<Payment>;
};

export type PaymentFulfilmentDeps = {
  getPayment: (merchantId: string, paymentId: string) => Promise<Payment>;
  markFulfilled: (merchantId: string, paymentId: string) => Promise<Payment>;
  ledger?: PolicyLedger;
};

/**
 * Confirms a settled payment. A repeat returns the stored payment and does not
 * submit another transaction. Without a ledger the call is unavailable.
 */
export function createPaymentFulfilmentService(deps: PaymentFulfilmentDeps): PaymentFulfilment {
  return {
    async fulfil(merchantId, paymentId) {
      const payment = await deps.getPayment(merchantId, paymentId);
      if (payment.status !== 'SETTLED') throw new DomainError('not-settled');
      if (payment.fulfilledAt !== null) return payment;
      if (deps.ledger === undefined) throw new DomainError('policy-unavailable');
      const outcome = await deps.ledger.markFulfilled({ orderRef: payment.id });
      if (outcome.status === 'rejected') {
        throw new DomainError('policy-rejected', { code: outcome.code, txHash: outcome.txHash });
      }
      if (outcome.status === 'unavailable') throw new DomainError('policy-unavailable');
      return deps.markFulfilled(merchantId, payment.id);
    },
  };
}
