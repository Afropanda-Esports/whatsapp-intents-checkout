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
    });
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
});
