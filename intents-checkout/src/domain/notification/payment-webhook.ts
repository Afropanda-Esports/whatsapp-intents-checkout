import type { PaymentStatus } from '../payment/types.js';

const TYPES: Partial<Record<PaymentStatus, string>> = {
  DEPOSIT_DETECTED: 'payment.deposit_detected',
  UNDERPAID: 'payment.underpaid',
  SETTLED: 'payment.settled',
  EXPIRED: 'payment.expired',
  RETURNED: 'payment.returned',
  FAILED: 'payment.failed',
};

/** Webhook type for a new payment status. Create and SETTLING have none. */
export function paymentWebhook(status: PaymentStatus): string | undefined {
  return TYPES[status];
}
