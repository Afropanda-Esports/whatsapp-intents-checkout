import type { OneClickStatus, Payment, PaymentStatus, PaymentStatusEvent, StatusSnapshot } from './types.js';

const TERMINAL = new Set<PaymentStatus>(['SETTLED', 'EXPIRED', 'RETURNED', 'FAILED']);

const MAPPED: Record<OneClickStatus, PaymentStatus> = {
  PENDING_DEPOSIT: 'AWAITING_DEPOSIT',
  KNOWN_DEPOSIT_TX: 'DEPOSIT_DETECTED',
  INCOMPLETE_DEPOSIT: 'UNDERPAID',
  PROCESSING: 'SETTLING',
  SUCCESS: 'SETTLED',
  REFUNDED: 'RETURNED',
  FAILED: 'FAILED',
};

export type AppliedStatus = {
  payment: Payment;
  event: PaymentStatusEvent | undefined;
};

/**
 * Maps one 1Click status onto the payment. A terminal payment is left alone.
 * PENDING_DEPOSIT after the deadline expires. A status that was already applied
 * does not produce another event.
 */
export function applyStatus(payment: Payment, snapshot: StatusSnapshot, now: Date): AppliedStatus {
  if (TERMINAL.has(payment.status)) return { payment, event: undefined };

  const next = nextStatus(snapshot.oneClickStatus, payment.deadline, now);
  if (next === payment.status) return { payment, event: undefined };

  const settledAmount =
    next === 'SETTLED' && snapshot.amountOut !== null ? snapshot.amountOut : payment.settledAmount;
  const updated: Payment = {
    ...payment,
    status: next,
    depositedAmount: snapshot.depositedAmount ?? payment.depositedAmount,
    settledAmount,
    originTxHashes: snapshot.originTxHashes,
    destinationTxHashes: snapshot.destinationTxHashes,
  };
  return {
    payment: updated,
    event: {
      fromStatus: payment.status,
      toStatus: next,
      oneClickStatus: snapshot.oneClickStatus,
      originTxHashes: snapshot.originTxHashes,
      destinationTxHashes: snapshot.destinationTxHashes,
    },
  };
}

function nextStatus(status: OneClickStatus, deadline: string, now: Date): PaymentStatus {
  if (status === 'PENDING_DEPOSIT' && now.getTime() > Date.parse(deadline)) return 'EXPIRED';
  return MAPPED[status];
}
