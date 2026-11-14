/**
 * 1Click POST /v0/quote response for a non-dry EXACT_OUTPUT request.
 * Shape from the 1Click API reference and SDK types (QuoteResponse / Quote), not a live capture:
 * neither build machine could reach 1Click on 2026-11-10. The live test checks the decoder
 * against the real API; replace this with a captured response after the first live run.
 */
export const USDC_NEAR_ASSET_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export function quoteResponseFixture(overrides: {
  amountOut?: string;
  depositAddress?: string | undefined;
  depositMemo?: string;
  deadline?: string;
} = {}): Record<string, unknown> {
  const amountOut = overrides.amountOut ?? '1000000';
  const quote: Record<string, unknown> = {
    amountIn: '1010203',
    amountInFormatted: '1.010203',
    amountInUsd: '1.0093',
    minAmountIn: '1000101',
    refundFee: '2400',
    maxAmountIn: '1020305',
    amountOut,
    amountOutFormatted: '1.0',
    amountOutUsd: '0.9998',
    minAmountOut: amountOut,
    deadline: overrides.deadline ?? '2026-11-10T01:30:00.000Z',
    timeWhenInactive: '2026-11-10T01:30:00.000Z',
    timeEstimate: 60,
  };
  if (!('depositAddress' in overrides) || overrides.depositAddress !== undefined) {
    quote['depositAddress'] = overrides.depositAddress ?? 'TFakeDepositAddressForTests000000001';
  }
  if (overrides.depositMemo !== undefined) quote['depositMemo'] = overrides.depositMemo;
  return {
    timestamp: '2026-11-10T01:00:00.000Z',
    signature: 'ed25519:FakeSignatureForTests',
    correlationId: 'corr-fixture-1',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_OUTPUT',
      amount: amountOut,
      destinationAsset: USDC_NEAR_ASSET_ID,
    },
    quote,
  };
}
