import { createHash } from 'node:crypto';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';

/**
 * One merchant until per-merchant keys live in the merchants table (slice 5).
 * Only the sha256 of the key is stored. No key means no merchant, so payment routes reject everyone.
 */
export async function registerDefaultMerchant(
  directory: MerchantDirectory,
  apiKey: string | undefined,
  newSecret: () => string,
): Promise<string | undefined> {
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  return directory.ensureDefault(apiKeyHash, newSecret());
}
