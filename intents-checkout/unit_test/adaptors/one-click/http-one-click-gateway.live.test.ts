import { describe, expect, it } from 'vitest';
import { USDC_NEAR_ASSET_ID } from '../../fixtures/quotes.js';
import { USDT_TRON_ASSET_ID } from '../../fixtures/tokens.js';
import { createHttpOneClickGateway } from '../../../src/adaptors/one-click/http-one-click-gateway.js';

describe('live 1Click tokens', () => {
  it('includes USDT on Tron and USDC on Base', async () => {
    const gateway = createHttpOneClickGateway({ baseUrl: 'https://1click.chaindefuser.com' });
    const assets = await gateway.listTokens();
    expect(assets.some((asset) => asset.symbol === 'USDT' && asset.blockchain === 'tron')).toBe(true);
    expect(assets.some((asset) => asset.symbol === 'USDC' && asset.blockchain === 'base')).toBe(true);
    expect(assets.every((asset) => !Object.hasOwn(asset, 'price'))).toBe(true);
  });
});

const treasury = process.env['LIVE_TREASURY_ACCOUNT_ID'];
const refundTo = process.env['LIVE_REFUND_TO_TRON'];

describe('live 1Click quote (unfunded: no money moves)', () => {
  it.skipIf(treasury === undefined || refundTo === undefined)(
    'requestQuote returns a deposit address for 1 USDC from USDT on Tron',
    async () => {
      const gateway = createHttpOneClickGateway({
        baseUrl: 'https://1click.chaindefuser.com',
        ...(process.env['ONE_CLICK_API_KEY'] ? { apiKey: process.env['ONE_CLICK_API_KEY'] } : {}),
      });
      const signed = await gateway.requestQuote({
        originAsset: USDT_TRON_ASSET_ID,
        destinationAsset: USDC_NEAR_ASSET_ID,
        amountOut: '1000000',
        recipient: treasury as string,
        refundTo: refundTo as string,
        deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        slippageBps: 100,
        quoteWaitingTimeMs: 2000,
      });
      expect(signed.terms.depositAddress.length).toBeGreaterThan(0);
      expect(signed.terms.amountOut).toBe('1000000');
      expect(BigInt(signed.terms.minAmountIn) <= BigInt(signed.terms.amountIn)).toBe(true);
      // Paste this into unit_test/fixtures/quotes.ts to replace the doc-derived fixture.
      console.log(JSON.stringify(signed.raw));
    },
  );
});
