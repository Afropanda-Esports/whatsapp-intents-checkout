import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { registerDefaultMerchant } from '../../src/domain/merchant/default-merchant.js';

describe('registerDefaultMerchant', () => {
  it('upserts by the sha256 hex of the key and never passes the raw key', async () => {
    const ensureDefault = vi.fn(async () => 'merchant-id');
    const id = await registerDefaultMerchant({ ensureDefault }, 'merchant-key', () => 'secret-hex');
    expect(id).toBe('merchant-id');
    expect(ensureDefault).toHaveBeenCalledWith(createHash('sha256').update('merchant-key').digest('hex'), 'secret-hex');
    expect(JSON.stringify(ensureDefault.mock.calls)).not.toContain('merchant-key');
  });

  it('returns undefined without touching the directory when no key is set', async () => {
    const ensureDefault = vi.fn(async () => 'merchant-id');
    expect(await registerDefaultMerchant({ ensureDefault }, undefined, () => 'x')).toBeUndefined();
    expect(ensureDefault).not.toHaveBeenCalled();
  });
});
