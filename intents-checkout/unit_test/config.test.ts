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

  it('does not put an unused API key on the config object', () => {
    const config = loadConfig({
      PORT: '3000',
      DATABASE_URL: 'postgres://localhost/db',
      ONE_CLICK_API_KEY: 'secret-key',
    });
    expect(config).toEqual({ port: 3000, databaseUrl: 'postgres://localhost/db' });
    expect(JSON.stringify(config)).not.toContain('secret-key');
  });
});
