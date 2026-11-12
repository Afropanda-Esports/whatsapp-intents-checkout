import { afterAll, describe, expect, it } from 'vitest';
import { buildAgent } from '../src/index.js';

describe('composition root', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('uses in-memory fakes unless both merchant URLs are set', async () => {
    const memory = await buildAgent({});
    const oneUrl = await buildAgent({ PANDA_PAY_BASE_URL: 'http://panda.test' });
    const http = await buildAgent({
      PANDA_PAY_BASE_URL: 'http://panda.test',
      CHECKOUT_BASE_URL: 'http://checkout.test',
      PANDA_PAY_API_KEY: 'panda-key',
      CHECKOUT_API_KEY: 'checkout-key',
    });
    apps.push(memory.app, oneUrl.app, http.app);
    expect(memory.transport).toBe('memory');
    expect(memory.inspection).toBeDefined();
    expect(oneUrl.transport).toBe('memory');
    expect(http.transport).toBe('http');
    expect(http.inspection).toBeUndefined();
  });
});
