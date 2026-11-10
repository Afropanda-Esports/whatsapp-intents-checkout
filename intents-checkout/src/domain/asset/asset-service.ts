import type { OriginAsset } from './origin-asset.js';

/** Cached catalog must not be older than this. */
export const ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

export type TokenSource = {
  listTokens(): Promise<OriginAsset[]>;
};

export type AssetServiceDeps = {
  tokens: TokenSource;
  clock: () => number;
  ttlMs?: number;
};

export type ListAssets = {
  listAssets(): Promise<OriginAsset[]>;
};

export function createAssetService(deps: AssetServiceDeps): ListAssets {
  const ttlMs = deps.ttlMs ?? ASSET_CACHE_TTL_MS;
  let cached: { at: number; assets: OriginAsset[] } | undefined;

  return {
    async listAssets() {
      const now = deps.clock();
      if (cached !== undefined && now - cached.at <= ttlMs) return cached.assets;
      const assets = await deps.tokens.listTokens();
      cached = { at: now, assets };
      return assets;
    },
  };
}
