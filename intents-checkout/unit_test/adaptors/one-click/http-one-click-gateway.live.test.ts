import { describe, expect, it } from 'vitest';
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
