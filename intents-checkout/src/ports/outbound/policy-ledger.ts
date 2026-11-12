export type RegisterPaymentInput = {
  orderRef: string;
  amountReceived: string;
  refundDestination: string;
  originAsset: string;
};

export type PolicyCallResult =
  | { status: 'ok'; txHash: string; value?: unknown }
  | { status: 'rejected'; code: string; txHash: string }
  | { status: 'unavailable' };

export type PolicyOrder = {
  refundDestination: string;
};

export type PolicyRequestView = {
  status: string;
  submitted: boolean;
};

export type PolicyView<T> = { status: 'ok'; value: T } | { status: 'unavailable' };

export type StorageRegistration = { status: 'registered' } | { status: 'unregistered' } | { status: 'unavailable' };

/** The on-chain spending guard. Implementations must not throw these outcomes. */
export type PolicyLedger = {
  registerPayment(input: RegisterPaymentInput): Promise<PolicyCallResult>;
  markFulfilled(input: { orderRef: string }): Promise<PolicyCallResult>;
  getOrder(orderRef: string): Promise<PolicyView<PolicyOrder | null>>;
  getRequest(requestId: string): Promise<PolicyView<PolicyRequestView | null>>;
  requestRefund(input: { orderRef: string; amount: string }): Promise<PolicyCallResult>;
  executeRefund(input: { requestId: string; depositAddress: string }): Promise<PolicyCallResult>;
  storageBalance(tokenAccountId: string, accountId: string): Promise<StorageRegistration>;
  storageDeposit(tokenAccountId: string, accountId: string): Promise<PolicyCallResult>;
};
