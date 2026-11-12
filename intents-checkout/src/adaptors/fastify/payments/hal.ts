import type { Payment } from '../../../domain/payment/types.js';
import { paymentResource, type PaymentResource } from '../../../domain/payment/payment-resource.js';

/** Merchant-facing payment resource. merchantId and refundTo stay internal. */
export function paymentHal(payment: Payment, publicBaseUrl: string): PaymentResource {
  return paymentResource(payment, publicBaseUrl);
}
