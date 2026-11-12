import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({ PORT: '3000' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://localhost/db' })).toThrow(/PORT/);
  });

  it('accepts PORT and DATABASE_URL when the optional keys are absent', () => {
    expect(loadConfig({ PORT: '3000', DATABASE_URL: 'postgres://localhost/db' })).toEqual({
      port: 3000,
      databaseUrl: 'postgres://localhost/db',
      checkoutEnabled: true,
    });
  });

  it('reads the catalog settings when they are set and strips a trailing slash', () => {
    expect(
      loadConfig({
        PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        PUBLIC_BASE_URL: 'https://checkout.example/',
        ONE_CLICK_BASE_URL: 'https://1click.example',
        ONE_CLICK_API_KEY: 'partner-key',
        MERCHANT_API_KEY: 'merchant-key',
      }),
    ).toEqual({
      port: 3000,
      databaseUrl: 'postgres://localhost/db',
      publicBaseUrl: 'https://checkout.example',
      oneClickBaseUrl: 'https://1click.example',
      oneClickApiKey: 'partner-key',
      merchantApiKey: 'merchant-key',
      checkoutEnabled: true,
    });
  });

  it('rejects a webhook URL that is not a URL', () => {
    expect(() =>
      loadConfig({
        PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        WEBHOOK_URL: 'not a url',
      }),
    ).toThrow(/WEBHOOK_URL/);
  });

  it('reads WEBHOOK_URL when it is set', () => {
    expect(
      loadConfig({
        PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        WEBHOOK_URL: 'https://merchant.example/hooks',
      }).webhookUrl,
    ).toBe('https://merchant.example/hooks');
  });

  it('rejects a public base URL that is not a URL', () => {
    expect(() =>
      loadConfig({
        PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        PUBLIC_BASE_URL: 'not a url',
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it('leaves checkout on unless CHECKOUT_ENABLED is exactly false', () => {
    const base = { PORT: '3000', DATABASE_URL: 'postgres://localhost/db' };
    expect(loadConfig(base).checkoutEnabled).toBe(true);
    expect(loadConfig({ ...base, CHECKOUT_ENABLED: '' }).checkoutEnabled).toBe(true);
    expect(loadConfig({ ...base, CHECKOUT_ENABLED: 'true' }).checkoutEnabled).toBe(true);
    expect(loadConfig({ ...base, CHECKOUT_ENABLED: 'false' }).checkoutEnabled).toBe(false);
    expect(() => loadConfig({ ...base, CHECKOUT_ENABLED: 'no' })).toThrow(/CHECKOUT_ENABLED/);
  });

  it('reads the NEAR operator settings only when all four are set', () => {
    const base = { PORT: '3000', DATABASE_URL: 'postgres://localhost/db' };
    const policy = {
      NEAR_RPC_URL: 'https://rpc.example',
      POLICY_CONTRACT_ID: 'policy.near',
      OPERATOR_ACCOUNT_ID: 'operator.near',
      OPERATOR_PRIVATE_KEY: 'ed25519:secret',
    };
    expect(loadConfig({ ...base, ...policy }).policy).toEqual({
      rpcUrl: 'https://rpc.example',
      contractId: 'policy.near',
      operatorAccountId: 'operator.near',
      operatorPrivateKey: 'ed25519:secret',
    });
    expect(loadConfig({ ...base, NEAR_RPC_URL: '', POLICY_CONTRACT_ID: '' }).policy).toBeUndefined();
    expect(() => loadConfig({ ...base, NEAR_RPC_URL: 'https://rpc.example' })).toThrow(/POLICY_CONTRACT_ID/);
    expect(() => loadConfig({ ...base, ...policy, NEAR_RPC_URL: 'not a url' })).toThrow(/NEAR_RPC_URL/);
  });
});
