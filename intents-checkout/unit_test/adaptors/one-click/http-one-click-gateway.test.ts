import { describe, expect, it, vi } from 'vitest';
import { createHttpOneClickGateway } from '../../../src/adaptors/one-click/http-one-click-gateway.js';
import { DomainError } from '../../../src/domain/domain-error.js';
import type { QuoteRequest } from '../../../src/domain/payment/types.js';
import { USDT_TRON_ASSET_ID } from '../../fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID, quoteResponseFixture } from '../../fixtures/quotes.js';

const request: QuoteRequest = {
  originAsset: USDT_TRON_ASSET_ID,
  destinationAsset: USDC_NEAR_ASSET_ID,
  amountOut: '1000000',
  recipient: 'checkout.afropanda.near',
  refundTo: 'TCustomerRefundAddress',
  deadline: '2026-11-10T01:30:00.000Z',
  slippageBps: 100,
  quoteWaitingTimeMs: 2000,
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
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

describe('requestQuote', () => {
  it('posts the 1Click quote body with the partner key and returns the terms and raw response', async () => {
    const fetchImpl = respond(200, quoteResponseFixture());
    const gateway = createHttpOneClickGateway({ baseUrl: 'https://1click.example', apiKey: 'partner', fetchImpl });
    const signed = await gateway.requestQuote(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://1click.example/v0/quote');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('partner');
    expect(JSON.parse(String(init.body))).toEqual({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: USDT_TRON_ASSET_ID,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: USDC_NEAR_ASSET_ID,
      amount: '1000000',
      refundTo: 'TCustomerRefundAddress',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'checkout.afropanda.near',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-10T01:30:00.000Z',
      quoteWaitingTimeMs: 2000,
    });
    expect(signed.terms).toEqual({
      depositAddress: 'TFakeDepositAddressForTests000000001',
      depositMemo: null,
      amountIn: '1010203',
      minAmountIn: '1000101',
      amountOut: '1000000',
      deadline: '2026-11-10T01:30:00.000Z',
    });
    expect(signed.raw).toEqual(quoteResponseFixture());
  });

  it('omits the key header when no key is configured and keeps a deposit memo', async () => {
    const fetchImpl = respond(200, quoteResponseFixture({ depositMemo: '12345' }));
    const signed = await createHttpOneClickGateway({ baseUrl: 'https://1click.example', fetchImpl }).requestQuote(request);
    const init = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init.headers as Record<string, string>).not.toHaveProperty('X-API-Key');
    expect(signed.terms.depositMemo).toBe('12345');
  });

  it('treats a response without a deposit address as unavailable', async () => {
    const fetchImpl = respond(200, quoteResponseFixture({ depositAddress: undefined }));
    expect(await codeOf(createHttpOneClickGateway({ baseUrl: 'https://1click.example', fetchImpl }).requestQuote(request))).toBe(
      'quote-unavailable',
    );
  });

  it.each([
    [500, 'quote-unavailable'],
    [503, 'quote-unavailable'],
    [401, 'quote-unavailable'],
    [403, 'quote-unavailable'],
    [400, 'quote-rejected'],
    [422, 'quote-rejected'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchImpl = respond(status, { message: 'refundTo is not a valid tron address' });
    expect(await codeOf(createHttpOneClickGateway({ baseUrl: 'https://1click.example', fetchImpl }).requestQuote(request))).toBe(code);
  });

  it('keeps the 1Click message on a rejected quote', async () => {
    const fetchImpl = respond(400, { message: 'refundTo is not a valid tron address' });
    const error = await createHttpOneClickGateway({ baseUrl: 'https://1click.example', fetchImpl })
      .requestQuote(request)
      .catch((e: unknown) => e);
    expect((error as DomainError).details).toEqual({ reason: 'refundTo is not a valid tron address' });
  });

  it('maps a network failure to quote-unavailable', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new TypeError('fetch failed')));
    expect(await codeOf(createHttpOneClickGateway({ baseUrl: 'https://1click.example', fetchImpl }).requestQuote(request))).toBe(
      'quote-unavailable',
    );
  });
});
