import type { Payment } from '../../../domain/payment/types.js';

/** Merchant-facing payment resource. merchantId and refundTo stay internal. */
export function paymentHal(payment: Payment, publicBaseUrl: string): Record<string, unknown> {
  return {
    paymentId: payment.id,
    merchantOrderId: payment.merchantOrderId,
    status: payment.status,
    originAsset: payment.originAsset,
    destinationAsset: payment.destinationAsset,
    amountOut: payment.amountOut,
    amountIn: payment.amountIn,
    minAmountIn: payment.minAmountIn,
    depositAddress: payment.depositAddress,
    depositMemo: payment.depositMemo,
    deadline: payment.deadline,
    confidential: payment.confidential,
    depositedAmount: payment.depositedAmount,
    settledAmount: payment.settledAmount,
    refundedAmount: payment.refundedAmount,
    originTxHashes: payment.originTxHashes,
    destinationTxHashes: payment.destinationTxHashes,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    _links: { self: { href: `${publicBaseUrl}/payments/v1/${encodeURIComponent(payment.id)}` } },
  };
}
