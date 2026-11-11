import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../src/domain/domain-error.js';
import { createPaymentCreationService } from '../../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../../src/domain/payment/payment-read-service.js';
import type { PaymentCreationDeps, PaymentSettings } from '../../src/domain/payment/payment-service-deps.js';
import type { NewPayment, Payment, SignedQuote } from '../../src/domain/payment/types.js';
import type { InsertPaymentResult } from '../../src/ports/outbound/payment-repository.js';
import { USDT_TRON_ASSET_ID } from '../fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../fixtures/quotes.js';

const MERCHANT = '7b1c3c3e-8d3f-4a7a-9d11-000000000001';
const NOW = new Date('2026-11-10T01:00:00.000Z');
const settings: PaymentSettings = {
  treasuryAccountId: 'checkout.afropanda.near',
  destinationAssetId: USDC_NEAR_ASSET_ID,
  paymentWindowMinutes: 30,
  slippageBps: 100,
};
const input = {
  merchantId: MERCHANT,
  merchantOrderId: 'PPA-1',
  amountOut: '1000000',
  originAsset: USDT_TRON_ASSET_ID,
  refundTo: 'TCustomerRefundAddress',
};

function quote(amountOut = '1000000'): SignedQuote {
  return {
    terms: {
      depositAddress: 'TDeposit1',
      depositMemo: null,
      amountIn: '1010203',
      minAmountIn: '1000101',
      amountOut,
      deadline: '2026-11-10T01:30:00.000Z',
    },
    raw: { signature: 'sig', quote: { amountOut } },
  };
}

function stored(newPayment: NewPayment, id = 'pay-1'): Payment {
  return {
    merchantId: newPayment.merchantId,
    merchantOrderId: newPayment.merchantOrderId,
    status: newPayment.status,
    originAsset: newPayment.originAsset,
    destinationAsset: newPayment.destinationAsset,
    amountOut: newPayment.amountOut,
    amountIn: newPayment.amountIn,
    minAmountIn: newPayment.minAmountIn,
    depositAddress: newPayment.depositAddress,
    depositMemo: newPayment.depositMemo,
    refundTo: newPayment.refundTo,
    confidential: newPayment.confidential,
    deadline: newPayment.deadline,
    id,
    depositedAmount: null,
    settledAmount: null,
    refundedAmount: '0',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function deps(overrides: Partial<PaymentCreationDeps> = {}) {
  const requestQuote = vi.fn(async () => quote());
  const listAssets = vi.fn(async () => [
    { assetId: USDT_TRON_ASSET_ID, symbol: 'USDT', blockchain: 'tron', decimals: 6 },
  ]);
  const findByMerchantOrder = vi.fn(async (): Promise<Payment | undefined> => undefined);
  const insertWithEvent = vi.fn(async (p: NewPayment): Promise<InsertPaymentResult> => ({ status: 'inserted', payment: stored(p) }));
  const findById = vi.fn(async (): Promise<Payment | undefined> => undefined);
  const built: PaymentCreationDeps = {
    quotes: { requestQuote },
    assets: { listAssets },
    payments: { findByMerchantOrder, insertWithEvent, findById },
    clock: () => NOW,
    settings,
    ...overrides,
  };
  return { built, requestQuote, listAssets, findByMerchantOrder, insertWithEvent };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('createPayment', () => {
  it('requests an EXACT_OUTPUT quote to the treasury with the configured window and slippage', async () => {
    const d = deps();
    const result = await createPaymentCreationService(d.built).createPayment(input);
    expect(result.created).toBe(true);
    expect(d.requestQuote).toHaveBeenCalledWith({
      originAsset: USDT_TRON_ASSET_ID,
      destinationAsset: USDC_NEAR_ASSET_ID,
      amountOut: '1000000',
      recipient: 'checkout.afropanda.near',
      refundTo: 'TCustomerRefundAddress',
      deadline: '2026-11-10T01:30:00.000Z',
      slippageBps: 100,
      quoteWaitingTimeMs: 2000,
    });
  });

  it('stores the payment as AWAITING_DEPOSIT with the quote terms and the full signed quote', async () => {
    const d = deps();
    const { payment } = await createPaymentCreationService(d.built).createPayment(input);
    const saved = d.insertWithEvent.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      merchantId: MERCHANT,
      merchantOrderId: 'PPA-1',
      status: 'AWAITING_DEPOSIT',
      amountOut: '1000000',
      amountIn: '1010203',
      minAmountIn: '1000101',
      depositAddress: 'TDeposit1',
      depositMemo: null,
      refundTo: 'TCustomerRefundAddress',
      confidential: false,
      deadline: '2026-11-10T01:30:00.000Z',
      quote: { signature: 'sig', quote: { amountOut: '1000000' } },
    });
    expect(payment.status).toBe('AWAITING_DEPOSIT');
  });

  it.each([
    ['zero amount', { amountOut: '0' }],
    ['leading zero', { amountOut: '0100' }],
    ['decimal point', { amountOut: '1.5' }],
    ['negative', { amountOut: '-1' }],
    ['79 digits', { amountOut: '1'.repeat(79) }],
    ['confidential checkout', { confidential: true }],
  ])('rejects %s as invalid-request without quoting', async (_name, change) => {
    const d = deps();
    expect(await codeOf(createPaymentCreationService(d.built).createPayment({ ...input, ...change }))).toBe(
      'invalid-request',
    );
    expect(d.requestQuote).not.toHaveBeenCalled();
  });

  it('accepts a 78-digit amount', async () => {
    const big = '9'.repeat(78);
    const d = deps({ quotes: { requestQuote: vi.fn(async () => quote(big)) } });
    expect((await createPaymentCreationService(d.built).createPayment({ ...input, amountOut: big })).created).toBe(true);
  });

  it('rejects an asset that is not in the catalog before quoting', async () => {
    const d = deps();
    const service = createPaymentCreationService(d.built);
    const error = await service.createPayment({ ...input, originAsset: 'nep141:unknown.near' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('unsupported-asset');
    expect((error as DomainError).details).toEqual({ originAsset: 'nep141:unknown.near' });
    expect(d.requestQuote).not.toHaveBeenCalled();
  });

  it('returns the existing payment for a repeat with the same body and does not quote again', async () => {
    const d = deps();
    const existing = stored({ ...(await (async () => {
      const first = deps();
      await createPaymentCreationService(first.built).createPayment(input);
      return first.insertWithEvent.mock.calls[0]![0];
    })()) }, 'pay-existing');
    d.findByMerchantOrder.mockResolvedValue(existing);
    const result = await createPaymentCreationService(d.built).createPayment(input);
    expect(result).toEqual({ payment: existing, created: false });
    expect(d.requestQuote).not.toHaveBeenCalled();
  });

  it.each([
    ['amountOut', { amountOut: '2000000' }],
    ['originAsset', { originAsset: 'nep141:other.near' }],
    ['refundTo', { refundTo: 'TOther' }],
  ])('rejects a repeat with a different %s as order-conflict with the paymentId', async (_name, change) => {
    const d = deps();
    const first = deps();
    await createPaymentCreationService(first.built).createPayment(input);
    d.findByMerchantOrder.mockResolvedValue(stored(first.insertWithEvent.mock.calls[0]![0], 'pay-existing'));
    const error = await createPaymentCreationService(d.built)
      .createPayment({ ...input, ...change })
      .catch((e: unknown) => e);
    expect((error as DomainError).code).toBe('order-conflict');
    expect((error as DomainError).details).toEqual({ paymentId: 'pay-existing' });
    expect(d.requestQuote).not.toHaveBeenCalled();
  });

  it('re-reads after losing the insert race and returns the winner', async () => {
    const d = deps();
    const winner = stored(
      {
        merchantId: MERCHANT,
        merchantOrderId: 'PPA-1',
        status: 'AWAITING_DEPOSIT',
        originAsset: USDT_TRON_ASSET_ID,
        destinationAsset: USDC_NEAR_ASSET_ID,
        amountOut: '1000000',
        amountIn: '1010203',
        minAmountIn: '1000101',
        depositAddress: 'TWinner',
        depositMemo: null,
        refundTo: 'TCustomerRefundAddress',
        confidential: false,
        deadline: '2026-11-10T01:30:00.000Z',
        quote: {},
      },
      'pay-winner',
    );
    d.findByMerchantOrder.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
    d.insertWithEvent.mockResolvedValue({ status: 'duplicate' });
    const result = await createPaymentCreationService(d.built).createPayment(input);
    expect(result).toEqual({ payment: winner, created: false });
  });

  it('is quote-unavailable when no treasury account is configured', async () => {
    const d = deps({
      settings: {
        destinationAssetId: settings.destinationAssetId,
        paymentWindowMinutes: settings.paymentWindowMinutes,
        slippageBps: settings.slippageBps,
      },
    });
    expect(await codeOf(createPaymentCreationService(d.built).createPayment(input))).toBe('quote-unavailable');
    expect(d.requestQuote).not.toHaveBeenCalled();
  });

  it('is quote-unavailable when the asset catalog is unavailable', async () => {
    const d = deps({ assets: { listAssets: vi.fn(async () => Promise.reject(new DomainError('tokens-unavailable'))) } });
    expect(await codeOf(createPaymentCreationService(d.built).createPayment(input))).toBe('quote-unavailable');
  });

  it('refuses a quote whose amountOut differs from the request and stores nothing', async () => {
    const d = deps({ quotes: { requestQuote: vi.fn(async () => quote('999999')) } });
    expect(await codeOf(createPaymentCreationService(d.built).createPayment(input))).toBe('quote-unavailable');
    expect(d.insertWithEvent).not.toHaveBeenCalled();
  });

  it('passes gateway errors through', async () => {
    const d = deps({
      quotes: { requestQuote: vi.fn(async () => Promise.reject(new DomainError('quote-rejected', { reason: 'bad refundTo' }))) },
    });
    expect(await codeOf(createPaymentCreationService(d.built).createPayment(input))).toBe('quote-rejected');
    expect(d.insertWithEvent).not.toHaveBeenCalled();
  });
});

describe('getPayment', () => {
  it('returns the merchant-scoped payment', async () => {
    const payment = { id: '5f0b7c1e-2f3a-4c55-9a51-1c8e2a6d9f10' } as Payment;
    const findById = vi.fn(async () => payment);
    const service = createPaymentReadService({ payments: { findById } });
    await expect(service.getPayment(MERCHANT, payment.id)).resolves.toBe(payment);
    expect(findById).toHaveBeenCalledWith(MERCHANT, payment.id);
  });

  it('is not-found for an unknown id', async () => {
    const service = createPaymentReadService({ payments: { findById: vi.fn(async () => undefined) } });
    expect(await codeOf(service.getPayment(MERCHANT, '5f0b7c1e-2f3a-4c55-9a51-1c8e2a6d9f10'))).toBe('not-found');
  });

  it('is not-found for a malformed id without querying', async () => {
    const findById = vi.fn(async () => undefined);
    const service = createPaymentReadService({ payments: { findById } });
    expect(await codeOf(service.getPayment(MERCHANT, 'not-a-uuid'))).toBe('not-found');
    expect(findById).not.toHaveBeenCalled();
  });
});
