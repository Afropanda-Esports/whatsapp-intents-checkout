export type RegisterPaymentInput = {
  orderRef: string;
  amountReceived: string;
  refundDestination: string;
  originAsset: string;
};

export type PolicyCallResult =
  | { status: 'ok'; txHash: string }
  | { status: 'rejected'; code: string; txHash: string }
  | { status: 'unavailable' };

/** The on-chain spending guard. Implementations must not throw these outcomes. */
export type PolicyLedger = {
  registerPayment(input: RegisterPaymentInput): Promise<PolicyCallResult>;
  markFulfilled(input: { orderRef: string }): Promise<PolicyCallResult>;
};
