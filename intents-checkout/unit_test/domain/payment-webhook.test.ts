import { describe, expect, it } from 'vitest';
import { paymentWebhook } from '../../src/domain/notification/payment-webhook.js';
import { createTrackPayments } from '../../src/domain/payment/track-payments.js';
import type { Payment, PaymentStatus, PaymentStatusEvent } from '../../src/domain/payment/types.js';
import type { OutboxInsert } from '../../src/ports/outbound/payment-repository.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

function payment(status: PaymentStatus = 'AWAITING_DEPOSIT'): Payment {
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
    deadline: '2026-11-11T12:30:00.000Z',
    depositedAmount: null,
    settledAmount: null,
    refundedAmount: '0',
    fulfilledAt: null,
    originTxHashes: [],
    destinationTxHashes: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe('paymentWebhook', () => {
  it('maps the six notifying statuses and skips create and settling', () => {
    expect(paymentWebhook('DEPOSIT_DETECTED')).toBe('payment.deposit_detected');
    expect(paymentWebhook('UNDERPAID')).toBe('payment.underpaid');
    expect(paymentWebhook('SETTLED')).toBe('payment.settled');
    expect(paymentWebhook('EXPIRED')).toBe('payment.expired');
    expect(paymentWebhook('RETURNED')).toBe('payment.returned');
    expect(paymentWebhook('FAILED')).toBe('payment.failed');
    expect(paymentWebhook('AWAITING_DEPOSIT')).toBeUndefined();
    expect(paymentWebhook('SETTLING')).toBeUndefined();
  });

  it('writes no outbox row for SETTLING or an empty webhook URL', async () => {
    const updates: OutboxInsert[][] = [];
    const track = createTrackPayments({
      payments: {
        listNonTerminal: async () => [payment()],
        updateWithEvent: async (updated, _event: PaymentStatusEvent, outbox) => {
          updates.push(outbox);
          return updated;
        },
      },
      statuses: {
        getStatus: async () => ({
          oneClickStatus: 'PROCESSING',
          depositedAmount: '15082000',
          amountOut: '1000000',
          originTxHashes: [],
          destinationTxHashes: [],
        }),
      },
      merchants: { getWebhookTarget: async () => ({ url: 'https://merchant.example/hooks', secret: 'secret' }) },
      publicBaseUrl: 'https://checkout.example',
      newEventId: () => 'event-1',
      clock: () => NOW,
      onSkip: () => undefined,
    });
    await track.trackOnce();
    expect(updates).toEqual([[]]);

    updates.length = 0;
    const settled = createTrackPayments({
      payments: {
        listNonTerminal: async () => [payment()],
        updateWithEvent: async (updated, _event: PaymentStatusEvent, outbox) => {
          updates.push(outbox);
          return updated;
        },
      },
      statuses: {
        getStatus: async () => ({
          oneClickStatus: 'SUCCESS',
          depositedAmount: '15082000',
          amountOut: '1000000',
          originTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/tx/origin-hash' }],
          destinationTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
        }),
      },
      merchants: { getWebhookTarget: async () => ({ url: '', secret: 'secret' }) },
      publicBaseUrl: 'https://checkout.example',
      newEventId: () => 'event-1',
      clock: () => NOW,
      onSkip: () => undefined,
    });
    await settled.trackOnce();
    expect(updates).toEqual([[]]);
  });
});
