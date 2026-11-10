import { describe, expect, it } from 'vitest';
import { decodeTokens } from '../../../src/adaptors/one-click/decode-tokens.js';
import { DomainError } from '../../../src/domain/domain-error.js';
import { USDC_BASE_ASSET_ID, USDT_TRON_ASSET_ID, tokenFixture } from '../../fixtures/tokens.js';

describe('decodeTokens', () => {
  it('keeps asset ids unchanged and drops the price and broken rows', () => {
    expect(decodeTokens(tokenFixture)).toEqual([
      { assetId: USDT_TRON_ASSET_ID, symbol: 'USDT', blockchain: 'tron', decimals: 6 },
      { assetId: USDC_BASE_ASSET_ID, symbol: 'USDC', blockchain: 'base', decimals: 6 },
      { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24 },
    ]);
  });

  it('rejects a payload that is not a list', () => {
    expect(() => decodeTokens({ tokens: [] })).toThrow(DomainError);
  });
});
