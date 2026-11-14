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

export const ONE_CLICK_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;

export type OneClickStatus = (typeof ONE_CLICK_STATUSES)[number];

export type ChainTx = {
  hash: string;
  explorerUrl: string;
};

/** What a status poll told us. Amounts are base-unit strings; floats from 1Click are already dropped. */
export type StatusSnapshot = {
  oneClickStatus: OneClickStatus;
  depositedAmount: string | null;
  amountOut: string | null;
  originTxHashes: ChainTx[];
  destinationTxHashes: ChainTx[];
};

export type PaymentStatusEvent = {
  fromStatus: PaymentStatus;
  toStatus: PaymentStatus;
  oneClickStatus: OneClickStatus;
  originTxHashes: ChainTx[];
  destinationTxHashes: ChainTx[];
};

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
    refundFee: string;
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
  /** Null on a payment created before the refund fee was stored. */
  refundFee: string | null;
  depositAddress: string;
  depositMemo: string | null;
  refundTo: string;
  confidential: boolean;
  deadline: string;
  depositedAmount: string | null;
  settledAmount: string | null;
  refundedAmount: string;
  fulfilledAt: string | null;
  originTxHashes: ChainTx[];
  destinationTxHashes: ChainTx[];
  createdAt: string;
  updatedAt: string;
};

export type NewPayment = Omit<
  Payment,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'depositedAmount'
  | 'settledAmount'
  | 'refundedAmount'
  | 'fulfilledAt'
  | 'originTxHashes'
  | 'destinationTxHashes'
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
