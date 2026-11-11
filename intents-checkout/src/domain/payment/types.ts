export const PAYMENT_STATUSES = [
  'AWAITING_DEPOSIT',
  'DEPOSIT_DETECTED',
  'UNDERPAID',
  'SETTLING',
  'SETTLED',
  'EXPIRED',
  'RETURNED',
  'FAILED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** What our quote request asks 1Click for. Amounts are base-unit decimal strings. */
export type QuoteRequest = {
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
  recipient: string;
  refundTo: string;
  deadline: string;
  slippageBps: number;
  quoteWaitingTimeMs: number;
};

/** The terms we act on, plus the full signed 1Click response kept verbatim for disputes. */
export type SignedQuote = {
  terms: {
    depositAddress: string;
    depositMemo: string | null;
    amountIn: string;
    minAmountIn: string;
    amountOut: string;
    deadline: string | null;
  };
  raw: unknown;
};

export type Payment = {
  id: string;
  merchantId: string;
  merchantOrderId: string;
  status: PaymentStatus;
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
  amountIn: string;
  minAmountIn: string;
  depositAddress: string;
  depositMemo: string | null;
  refundTo: string;
  confidential: boolean;
  deadline: string;
  depositedAmount: string | null;
  settledAmount: string | null;
  refundedAmount: string;
  createdAt: string;
  updatedAt: string;
};

export type NewPayment = Omit<
  Payment,
  'id' | 'createdAt' | 'updatedAt' | 'depositedAmount' | 'settledAmount' | 'refundedAmount'
> & { quote: unknown };

export type CreatePaymentInput = {
  merchantId: string;
  merchantOrderId: string;
  amountOut: string;
  originAsset: string;
  refundTo: string;
  confidential?: boolean;
};

export type CreatePaymentResult = { payment: Payment; created: boolean };
