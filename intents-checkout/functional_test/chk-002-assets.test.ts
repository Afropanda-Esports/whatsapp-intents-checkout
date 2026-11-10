import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { ASSET_CACHE_TTL_MS, createAssetService } from '../src/domain/asset/asset-service.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createLogger } from '../src/logging.js';
import { USDC_BASE_ASSET_ID, USDT_TRON_ASSET_ID, tokenFixture } from '../unit_test/fixtures/tokens.js';

const merchantKey = 'merchant-key';
const publicBaseUrl = 'https://checkout.example';

describe('CHK-002 asset catalog', () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('lists the live token ids in HAL and caches them for five minutes', async () => {
    let calls = 0;
    const fake = createServer((request, response) => {
      if (request.url === '/v0/tokens') {
        calls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(tokenFixture));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
    const port = (fake.address() as AddressInfo).port;

    let now = 10_000;
    const assets = createAssetService({
      tokens: createHttpOneClickGateway({ baseUrl: `http://127.0.0.1:${port}` }),
      clock: () => now,
    });
    const auth = createMerchantAuth(merchantKey);
    const app = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger: createLogger(),
      assets: {
        authenticate: (apiKey) => auth.authenticate(apiKey),
        listAssets: () => assets.listAssets(),
        publicBaseUrl,
      },
    });

    const missing = await app.inject({ method: 'GET', url: '/assets/v1' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.json()).toMatchObject({
      type: 'https://checkout.example/problems/unauthorized',
      status: 401,
    });
    expect(calls).toBe(0);

    const first = await app.inject({
      method: 'GET',
      url: '/assets/v1',
      headers: { 'x-api-key': merchantKey },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/hal+json');
    const body = first.json<{
      _links: { self: { href: string } };
      _embedded: { assets: Array<{ assetId: string; symbol: string; blockchain: string }> };
    }>();
    expect(body._links.self.href).toBe('https://checkout.example/assets/v1');
    const ids = body._embedded.assets.map((asset) => asset.assetId);
    expect(ids).toEqual([USDT_TRON_ASSET_ID, USDC_BASE_ASSET_ID, 'nep141:wrap.near']);
    expect(JSON.stringify(body)).not.toContain('"price"');
    const usdt = body._embedded.assets.find((asset) => asset.assetId === USDT_TRON_ASSET_ID);
    expect(usdt).toMatchObject({ symbol: 'USDT', blockchain: 'tron' });

    const second = await app.inject({
      method: 'GET',
      url: '/assets/v1',
      headers: { 'x-api-key': merchantKey },
    });
    expect(second.statusCode).toBe(200);
    expect(calls).toBe(1);

    now += ASSET_CACHE_TTL_MS + 1;
    await app.inject({ method: 'GET', url: '/assets/v1', headers: { 'x-api-key': merchantKey } });
    expect(calls).toBe(2);
    await app.close();
  });

  it('returns tokens-unavailable when 1Click fails and does not echo the partner key', async () => {
    const fake = createServer((_request, response) => {
      response.writeHead(503);
      response.end('partner-key-should-not-leak');
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
    const port = (fake.address() as AddressInfo).port;
    const assets = createAssetService({
      tokens: createHttpOneClickGateway({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'partner-key-should-not-leak',
      }),
      clock: () => 0,
    });
    const app = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger: createLogger(),
      assets: {
        authenticate: (apiKey) => createMerchantAuth(merchantKey).authenticate(apiKey),
        listAssets: () => assets.listAssets(),
        publicBaseUrl,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/assets/v1',
      headers: { 'x-api-key': merchantKey, 'x-request-id': 'cid-assets' },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ type: string; correlationId: string }>();
    expect(body).toMatchObject({
      type: 'https://checkout.example/problems/tokens-unavailable',
      status: 503,
      correlationId: 'cid-assets',
    });
    expect(JSON.stringify(body)).not.toContain('partner-key');
    await app.close();
  });
});