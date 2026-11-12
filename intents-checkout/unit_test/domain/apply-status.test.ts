import { describe, expect, it } from 'vitest';
import { applyStatus } from '../../src/domain/payment/apply-status.js';
import type { OneClickStatus, Payment, StatusSnapshot } from '../../src/domain/payment/types.js';

const DEADLINE = '2026-11-10T01:30:00.000Z';
const BEFORE = new Date('2026-11-10T01:00:00.000Z');
const AFTER = new Date('2026-11-10T01:30:00.001Z');

function payment(status: Payment['status'] = 'AWAITING_DEPOSIT'): Payment {
  return {
    id: 'pay-1',
    merchantId: 'merchant-1',
    merchantOrderId: 'PPA-1',
    status,
    originAsset: 'nep141:origin',
    destinationAsset: 'nep141:usdc',
    amountOut: '1000000',
    amountIn: '1010000',
    minAmountIn: '1000000',
    depositAddress: 'TDeposit',
    depositMemo: null,
    refundTo: 'TCustomer',
    confidential: false,
    deadline: DEADLINE,
    depositedAmount: null,
    settledAmount: null,
    refundedAmount: '0',
    fulfilledAt: null,
    originTxHashes: [],
    destinationTxHashes: [],
    createdAt: BEFORE.toISOString(),
    updatedAt: BEFORE.toISOString(),
  };
}

function snapshot(oneClickStatus: OneClickStatus, amountOut: string | null = '1000000'): StatusSnapshot {
  return {
    oneClickStatus,
    depositedAmount: '15082000',
    amountOut,
    originTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/tx/origin-hash' }],
    destinationTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
  };
}

describe('applyStatus', () => {
  it.each([
    ['PENDING_DEPOSIT', 'AWAITING_DEPOSIT'],
    ['KNOWN_DEPOSIT_TX', 'DEPOSIT_DETECTED'],
    ['INCOMPLETE_DEPOSIT', 'UNDERPAID'],
    ['PROCESSING', 'SETTLING'],
    ['SUCCESS', 'SETTLED'],
    ['REFUNDED', 'RETURNED'],
    ['FAILED', 'FAILED'],
  ] as const)('maps %s to %s', (oneClickStatus, expected) => {
    const applied = applyStatus(payment(), snapshot(oneClickStatus), BEFORE);
    expect(applied.payment.status).toBe(expected);
  });

  it('expires a pending deposit only after the deadline', () => {
    expect(applyStatus(payment(), snapshot('PENDING_DEPOSIT'), new Date(DEADLINE)).event).toBeUndefined();
    const expired = applyStatus(payment(), snapshot('PENDING_DEPOSIT'), AFTER);
    expect(expired.payment.status).toBe('EXPIRED');
    expect(expired.event?.oneClickStatus).toBe('PENDING_DEPOSIT');
  });

  it('does not expire a deposit that 1Click has already seen', () => {
    const applied = applyStatus(payment(), snapshot('KNOWN_DEPOSIT_TX'), AFTER);
    expect(applied.payment.status).toBe('DEPOSIT_DETECTED');
  });

  it('sets settledAmount from the status amount only when the payment settles', () => {
    const settling = applyStatus(payment(), snapshot('PROCESSING'), BEFORE);
    expect(settling.payment.settledAmount).toBeNull();
    const settled = applyStatus(payment(), snapshot('SUCCESS', '1000000'), BEFORE);
    expect(settled.payment.settledAmount).toBe('1000000');
    expect(settled.payment.originTxHashes).toEqual(snapshot('SUCCESS').originTxHashes);
  });

  it('does not write an event when the mapped status is unchanged', () => {
    expect(applyStatus(payment(), snapshot('PENDING_DEPOSIT'), BEFORE).event).toBeUndefined();
  });

  it('leaves a terminal payment unchanged', () => {
    const settled = payment('SETTLED');
    const applied = applyStatus(settled, snapshot('FAILED'), BEFORE);
    expect(applied.payment).toBe(settled);
    expect(applied.event).toBeUndefined();
  });
});
