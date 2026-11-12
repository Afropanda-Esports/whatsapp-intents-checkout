/** Merchant-facing refund. Field order is the order a webhook signs. */
export type RefundResource = {
  refundId: string;
  paymentId: string;
  status: string;
  amount: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  _links: { self: { href: string } };
};

export function refundResource(input: {
  id: string;
  paymentId: string;
  status: string;
  amount: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  publicBaseUrl: string;
}): RefundResource {
  return {
    refundId: input.id,
    paymentId: input.paymentId,
    status: input.status,
    amount: input.amount,
    reason: input.reason,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    _links: {
      self: {
        href: `${input.publicBaseUrl}/payments/v1/${encodeURIComponent(input.paymentId)}/refunds/${encodeURIComponent(input.id)}`,
      },
    },
  };
}
