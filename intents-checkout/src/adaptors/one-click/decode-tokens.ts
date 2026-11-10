import { z } from 'zod';
import type { OriginAsset } from '../../domain/asset/origin-asset.js';
import { DomainError } from '../../domain/domain-error.js';

const tokenSchema = z
  .object({
    assetId: z.string().min(1),
    symbol: z.string().min(1),
    blockchain: z.string().min(1),
    decimals: z.number().int().nonnegative(),
  })
  .strip();

/** Keep well-formed tokens. Drop the rest, including the USD price float. */
export function decodeTokens(payload: unknown): OriginAsset[] {
  const list = z.array(z.unknown()).safeParse(payload);
  if (!list.success) throw new DomainError('tokens-unavailable');
  const assets: OriginAsset[] = [];
  for (const item of list.data) {
    const parsed = tokenSchema.safeParse(item);
    if (!parsed.success) continue;
    assets.push({
      assetId: parsed.data.assetId,
      symbol: parsed.data.symbol,
      blockchain: parsed.data.blockchain,
      decimals: parsed.data.decimals,
    });
  }
  return assets;
}
