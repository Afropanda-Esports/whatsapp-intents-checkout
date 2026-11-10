import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/domain-error.js';
import { createMerchantAuth } from '../../src/domain/merchant/merchant-auth-service.js';

describe('merchant auth', () => {
  const auth = createMerchantAuth('merchant-key');

  it('accepts the configured key', () => {
    expect(() => auth.authenticate('merchant-key')).not.toThrow();
  });

  it('rejects a missing, empty, or different key', () => {
    expect(() => auth.authenticate(undefined)).toThrow(DomainError);
    expect(() => auth.authenticate('')).toThrow(DomainError);
    expect(() => auth.authenticate('other-key')).toThrow(DomainError);
  });

  it('rejects everyone when no key is configured', () => {
    expect(() => createMerchantAuth('').authenticate('merchant-key')).toThrow(DomainError);
  });
});
