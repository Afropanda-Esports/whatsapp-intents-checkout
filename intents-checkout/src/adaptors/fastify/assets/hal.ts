import type { OriginAsset } from '../../../domain/asset/origin-asset.js';

export function assetsHal(assets: readonly OriginAsset[], publicBaseUrl: string): Record<string, unknown> {
  const collectionHref = `${publicBaseUrl}/assets/v1`;
  return {
    _links: { self: { href: collectionHref } },
    _embedded: {
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        symbol: asset.symbol,
        blockchain: asset.blockchain,
        decimals: asset.decimals,
        _links: { self: { href: `${collectionHref}/${encodeURIComponent(asset.assetId)}` } },
      })),
    },
  };
}
