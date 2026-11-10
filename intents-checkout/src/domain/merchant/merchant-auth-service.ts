import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain-error.js';

export type AuthenticateMerchant = {
  authenticate(presentedKey: string | undefined): void;
};

/**
 * One shared merchant key until keys are loaded from the merchants table.
 * An empty expected key rejects everyone, so a missing env var does not leave the route open.
 */
export function createMerchantAuth(expectedKey: string): AuthenticateMerchant {
  return {
    authenticate(presentedKey) {
      if (!sameKey(expectedKey, presentedKey)) throw new DomainError('unauthorized');
    },
  };
}

function sameKey(expected: string, presented: string | undefined): boolean {
  if (expected.length === 0 || presented === undefined || presented.length === 0) return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const presentedHash = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expectedHash, presentedHash);
}
