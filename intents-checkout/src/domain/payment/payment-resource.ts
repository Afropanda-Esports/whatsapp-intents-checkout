import type { ChainTx, Payment } from './types.js';

/** Merchant-facing payment. merchantId and refundTo stay off this object. */
export type PaymentResource = {
  paymentId: string;
  merchantOrderId: string;
  status: string;
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
  amountIn: string;
  minAmountIn: string;
  depositAddress: string;
  depositMemo: string | null;
  deadline: string;
  confidential: boolean;
  depositedAmount: string | null;
  settledAmount: string | null;
  refundedAmount: string;
  originTxHashes: ChainTx[];
  destinationTxHashes: ChainTx[];
  createdAt: string;
  updatedAt: string;
  _links: { self: { href: string } };
};

/** Field order is the order JSON.stringify signs and sends. */
export function paymentResource(payment: Payment, publicBaseUrl: string): PaymentResource {
  return orderedResource({
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
    originTxHashes: payment.originTxHashes.map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    destinationTxHashes: payment.destinationTxHashes.map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    _links: { self: { href: `${publicBaseUrl}/payments/v1/${encodeURIComponent(payment.id)}` } },
  });
}

export function orderedResource(resource: PaymentResource): PaymentResource {
  return {
    paymentId: resource.paymentId,
    merchantOrderId: resource.merchantOrderId,
    status: resource.status,
    originAsset: resource.originAsset,
    destinationAsset: resource.destinationAsset,
    amountOut: resource.amountOut,
    amountIn: resource.amountIn,
    minAmountIn: resource.minAmountIn,
    depositAddress: resource.depositAddress,
    depositMemo: resource.depositMemo,
    deadline: resource.deadline,
    confidential: resource.confidential,
    depositedAmount: resource.depositedAmount,
    settledAmount: resource.settledAmount,
    refundedAmount: resource.refundedAmount,
    originTxHashes: resource.originTxHashes.map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    destinationTxHashes: resource.destinationTxHashes.map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    _links: { self: { href: resource._links.self.href } },
  };
}
