import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paymentResource } from '../../src/domain/payment/payment-resource.js';
import { webhookJson, webhookJsonFromStored } from '../../src/domain/notification/webhook-body.js';
import { retryDelayMs } from '../../src/domain/notification/webhook-retry.js';
import { checkoutSignature } from '../../src/domain/notification/webhook-signature.js';
import type { Payment } from '../../src/domain/payment/types.js';

const BODY = '{"eventId":"abc"}';

describe('checkoutSignature', () => {
  it('signs t.body with HMAC-SHA256', () => {
    const header = checkoutSignature('secret', BODY, 1_700_000_000);
    const expected = createHmac('sha256', 'secret').update(`1700000000.${BODY}`).digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected}`);
    expect(expected).toBe('57d33a570ec941f2fa77028743e3da2999a220374bac5c58ec1a0520b41de720');
  });
});

describe('retryDelayMs', () => {
  it('starts at 30 seconds, doubles, and caps at one hour', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(7)).toBe(1_920_000);
    expect(retryDelayMs(8)).toBe(3_600_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
});

describe('webhookJson', () => {
  it('rebuilds the same bytes when the stored object keys are reordered', () => {
    const payment: Payment = {
      id: 'pay-1',
      merchantId: 'merchant-1',
      merchantOrderId: 'PPA-1',
      status: 'SETTLED',
      originAsset: 'nep141:origin',
      destinationAsset: 'nep141:usdc',
      amountOut: '1000000',
      amountIn: '1010000',
      minAmountIn: '1000000',
      refundFee: null,
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
    const data = paymentResource(payment, 'https://checkout.example');
    const original = webhookJson({
      eventId: 'event-1',
      type: 'payment.settled',
      occurredAt: '2026-11-11T12:00:00.000Z',
      data,
    });
    const stored = JSON.parse(original) as Record<string, unknown>;
    const reordered = {
      _links: stored['_links'],
      data: stored['data'],
      occurredAt: stored['occurredAt'],
      type: stored['type'],
      eventId: stored['eventId'],
    };
    expect(webhookJsonFromStored(reordered)).toBe(original);
    expect(original).not.toContain('refundTo');
    expect(original).not.toContain('merchant-1');
  });
});
