import { describe, expect, it, vi } from 'vitest';
import { ASSET_CACHE_TTL_MS, createAssetService } from '../../src/domain/asset/asset-service.js';
import { DomainError } from '../../src/domain/domain-error.js';
import type { OriginAsset } from '../../src/domain/asset/origin-asset.js';

const sample: OriginAsset[] = [
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24 },
];

describe('asset cache', () => {
  it('reuses the list until the five minute window has passed', async () => {
    let now = 1_000;
    const listTokens = vi.fn(async () => sample);
    const assets = createAssetService({ tokens: { listTokens }, clock: () => now });

    await assets.listAssets();
    await assets.listAssets();
    expect(listTokens).toHaveBeenCalledTimes(1);

    now += ASSET_CACHE_TTL_MS;
    await assets.listAssets();
    expect(listTokens).toHaveBeenCalledTimes(1);

    now += 1;
    await assets.listAssets();
    expect(listTokens).toHaveBeenCalledTimes(2);
  });

  it('does not store a failed fetch', async () => {
    const listTokens = vi
      .fn<() => Promise<OriginAsset[]>>()
      .mockRejectedValueOnce(new DomainError('tokens-unavailable'))
      .mockResolvedValueOnce(sample);
    const assets = createAssetService({ tokens: { listTokens }, clock: () => 0 });

    await expect(assets.listAssets()).rejects.toMatchObject({ code: 'tokens-unavailable' });
    await expect(assets.listAssets()).resolves.toEqual(sample);
    expect(listTokens).toHaveBeenCalledTimes(2);
  });
});
