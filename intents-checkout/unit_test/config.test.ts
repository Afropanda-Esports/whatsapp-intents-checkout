import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** `KEY: value` lines under one service's `environment:` in a compose file. */
function composeServiceEnv(compose: string, service: string): Record<string, string> {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`service ${service} not found`);
  const env: Record<string, string> = {};
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/u.test(line)) break;
    if (/^ {4}\S/u.test(line)) {
      inEnv = line.trim() === 'environment:';
      continue;
    }
    const pair = /^ {6}([A-Z0-9_]+):\s*(.*)$/u.exec(line);
    if (inEnv && pair?.[1] !== undefined && pair[2] !== undefined) {
      env[pair[1]] = pair[2].replace(/^"(.*)"$/u, '$1');
    }
  }
  return env;
}

describe('root docker-compose.yml', () => {
  it('starts intents-checkout with a config loadConfig accepts', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    const env = composeServiceEnv(compose, 'intents-checkout');
    expect(env['WEBHOOK_URL']).toBeDefined();
    expect(() => loadConfig(env)).not.toThrow();
  });
});

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
      checkoutMode: 'live',
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
      checkoutMode: 'live',
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

  it.each(['https://merchant.example', 'https://merchant.example/', 'ftp://merchant.example/hooks'])(
    'rejects webhook URL %s, which has no path or is not http(s)',
    (url) => {
      expect(() =>
        loadConfig({
          PORT: '3000',
          DATABASE_URL: 'postgres://localhost/db',
          WEBHOOK_URL: url,
        }),
      ).toThrow(/WEBHOOK_URL/);
    },
  );

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

  it('treats an unset CHECKOUT_MODE as live and accepts fake', () => {
    const base = { PORT: '3000', DATABASE_URL: 'postgres://localhost/db' };
    expect(loadConfig(base).checkoutMode).toBe('live');
    expect(loadConfig({ ...base, CHECKOUT_MODE: '' }).checkoutMode).toBe('live');
    expect(loadConfig({ ...base, CHECKOUT_MODE: 'live' }).checkoutMode).toBe('live');
    expect(loadConfig({ ...base, CHECKOUT_MODE: 'fake' }).checkoutMode).toBe('fake');
  });

  it('rejects a CHECKOUT_MODE other than live or fake', () => {
    expect(() =>
      loadConfig({
        PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        CHECKOUT_MODE: 'nope',
      }),
    ).toThrow(/CHECKOUT_MODE/);
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
