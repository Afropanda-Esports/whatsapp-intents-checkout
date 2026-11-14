import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paymentResource } from '../../src/domain/payment/payment-resource.js';
import type { Payment } from '../../src/domain/payment/types.js';

function payment(refundFee: string | null): Payment {
  return {
    id: 'pay-1',
    merchantId: 'merchant-1',
    merchantOrderId: 'PPA-1',
    status: 'AWAITING_DEPOSIT',
    originAsset: 'nep141:origin',
    destinationAsset: 'nep141:usdc',
    amountOut: '1000000',
    amountIn: '1014614',
    minAmountIn: '1004511',
    refundFee,
    depositAddress: '0xdeposit',
    depositMemo: null,
    refundTo: '0xrefund',
    confidential: false,
    deadline: '2026-11-13T19:01:49.533Z',
    depositedAmount: null,
    settledAmount: null,
    refundedAmount: '0',
    fulfilledAt: null,
    originTxHashes: [],
    destinationTxHashes: [],
    createdAt: '2026-11-13T18:31:49.533Z',
    updatedAt: '2026-11-13T18:31:49.533Z',
  };
}

describe('paymentResource refund fee', () => {
  it('places refundFee immediately after minAmountIn', () => {
    const body = JSON.stringify(paymentResource(payment('2400'), 'https://checkout.example'));
    expect(body.indexOf('"minAmountIn"')).toBeLessThan(body.indexOf('"refundFee":"2400"'));
    expect(body.indexOf('"refundFee":"2400"')).toBeLessThan(body.indexOf('"depositAddress"'));
    expect(JSON.parse(body).amountIn).toBe('1014614');
  });

  it('omits a null refund fee', () => {
    const body = JSON.stringify(paymentResource(payment(null), 'https://checkout.example'));
    expect(body).not.toContain('refundFee');
  });
});

describe('OpenAPI payment refund fee', () => {
  it('allows a string or null', () => {
    const yaml = readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8');
    expect(yaml).toMatch(/refundFee:\n {10}type: \[string, 'null'\]/);
  });
});
