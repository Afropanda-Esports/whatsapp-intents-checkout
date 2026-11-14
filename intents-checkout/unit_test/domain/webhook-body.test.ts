import { describe, expect, it } from 'vitest';
import { webhookJson, webhookJsonFromStored } from '../../src/domain/notification/webhook-body.js';
import { paymentResource } from '../../src/domain/payment/payment-resource.js';
import type { Payment } from '../../src/domain/payment/types.js';

function payment(refundFee: string | null): Payment {
  return {
    id: 'pay-1',
    merchantId: 'merchant-1',
    merchantOrderId: 'PPA-1',
    status: 'SETTLED',
    originAsset: 'nep141:origin',
    destinationAsset: 'nep141:usdc',
    amountOut: '1000000',
    amountIn: '1010000',
    minAmountIn: '1000000',
    refundFee,
    depositAddress: 'TDeposit',
    depositMemo: null,
    refundTo: 'TCustomer',
    confidential: false,
    deadline: '2026-11-11T12:30:00.000Z',
    depositedAmount: '15082000',
    settledAmount: '1000000',
    refundedAmount: '0',
    fulfilledAt: null,
    originTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/tx/origin-hash' }],
    destinationTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
    createdAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
  };
}

function signed(refundFee: string | null): string {
  return webhookJson({
    eventId: 'event-1',
    type: 'payment.settled',
    occurredAt: '2026-11-11T12:00:00.000Z',
    data: paymentResource(payment(refundFee), 'https://checkout.example'),
  });
}

describe('webhook refund fee', () => {
  it('rebuilds an older event that has no refund fee to the same bytes', () => {
    const original = signed(null);
    expect(original).not.toContain('refundFee');
    const stored = JSON.parse(original) as Record<string, unknown>;
    expect(webhookJsonFromStored(stored)).toBe(original);
  });

  it('keeps a present refund fee in the rebuilt bytes', () => {
    const original = signed('2400');
    expect(original.indexOf('"minAmountIn"')).toBeLessThan(original.indexOf('"refundFee":"2400"'));
    expect(webhookJsonFromStored(JSON.parse(original))).toBe(original);
  });
});
