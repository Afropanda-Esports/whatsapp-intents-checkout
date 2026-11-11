import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { runMigrations } from '../src/adaptors/postgres/migrate.js';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from '../src/adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresPaymentRepository } from '../src/adaptors/postgres/postgres-payment-repository.js';
import { createAssetService } from '../src/domain/asset/asset-service.js';
import { registerDefaultMerchant } from '../src/domain/merchant/default-merchant.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createPaymentCreationService } from '../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeOneClick, type FakeOneClick } from './fakes/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-003-${randomUUID()}`;

describe('CHK-003 create payment', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let app: FastifyInstance;
  let merchantId: string;

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
    pool = createPool(databaseUrl, () => {});
    await runMigrations(pool);
    fake = await startFakeOneClick();
    const directory = createPostgresMerchantDirectory(pool);
    const id = await registerDefaultMerchant(directory, merchantKey, () => randomUUID());
    if (id === undefined) throw new Error('no merchant');
    merchantId = id;
    const gateway = createHttpOneClickGateway({ baseUrl: fake.url });
    const payments = createPostgresPaymentRepository(pool);
    const create = createPaymentCreationService({
      quotes: gateway,
      assets: createAssetService({ tokens: gateway, clock: () => Date.now() }),
      payments,
      clock: () => new Date(),
      settings: {
        treasuryAccountId: 'checkout.afropanda.near',
        destinationAssetId: USDC_NEAR_ASSET_ID,
        paymentWindowMinutes: 30,
        slippageBps: 100,
      },
    });
    const read = createPaymentReadService({ payments });
    const auth = createMerchantAuth(merchantKey);
    app = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger: createLogger(),
      payments: {
        authenticate: (key) => auth.authenticate(key),
        createPayment: (input) => create.createPayment(input),
        getPayment: (merchant, paymentId) => read.getPayment(merchant, paymentId),
        merchantId,
        publicBaseUrl: BASE,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    if (pool !== undefined && merchantId !== undefined) {
      await pool.query('DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [merchantId]);
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
    await pool?.end();
  });

  function create(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/payments/v1',
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify(body),
    });
  }

  const order = () => ({
    merchantOrderId: `PPA-${randomUUID().slice(0, 8)}`,
    amountOut: '1000000',
    originAsset: USDT_TRON_ASSET_ID,
    refundTo: 'TCustomerRefundAddress',
  });

  it('CHK-003 creates a payment once, stores the signed quote, and returns it on repeat and GET', async () => {
    const body = order();
    const before = fake.quoteBodies.length;
    const first = await create(body);
    expect(first.statusCode).toBe(201);
    expect(first.headers['content-type']).toContain('application/hal+json');
    const created = first.json<{ paymentId: string; depositAddress: string; amountOut: string; status: string; _links: { self: { href: string } } }>();
    expect(created.status).toBe('AWAITING_DEPOSIT');
    expect(created.depositAddress).toMatch(/^TFakeDeposit/);
    expect(created.amountOut).toBe('1000000');
    expect(created._links.self.href).toBe(`${BASE}/payments/v1/${created.paymentId}`);
    expect(fake.quoteBodies[before]).toMatchObject({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      amount: '1000000',
      recipient: 'checkout.afropanda.near',
      destinationAsset: USDC_NEAR_ASSET_ID,
      refundTo: 'TCustomerRefundAddress',
    });

    const repeat = await create(body);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json<{ paymentId: string }>().paymentId).toBe(created.paymentId);
    expect(fake.quoteBodies.length).toBe(before + 1);

    const got = await app.inject({ method: 'GET', url: `/payments/v1/${created.paymentId}`, headers: { 'x-api-key': merchantKey } });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(first.json());

    const row = await pool.query<{ quote: { signature: string; quote: { depositAddress: string } } }>(
      'SELECT quote FROM payments WHERE id = $1',
      [created.paymentId],
    );
    expect(row.rows[0]?.quote.signature).toBe('ed25519:FakeSignatureForTests');
    expect(row.rows[0]?.quote.quote.depositAddress).toBe(created.depositAddress);
    const events = await pool.query<{ from_status: string | null; to_status: string }>(
      'SELECT from_status, to_status FROM payment_events WHERE payment_id = $1',
      [created.paymentId],
    );
    expect(events.rows).toEqual([{ from_status: null, to_status: 'AWAITING_DEPOSIT' }]);
  });

  it('CHK-003 rejects a changed body for the same order with 409 and the existing paymentId', async () => {
    const body = order();
    const first = (await create(body)).json<{ paymentId: string }>();
    const conflict = await create({ ...body, amountOut: '2000000' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ type: `${BASE}/problems/order-conflict`, paymentId: first.paymentId });
  });

  it('CHK-003 rejects an unsupported asset with 422 before quoting', async () => {
    const before = fake.quoteBodies.length;
    const response = await create({ ...order(), originAsset: 'nep141:not-listed.near' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/unsupported-asset`, originAsset: 'nep141:not-listed.near' });
    expect(fake.quoteBodies.length).toBe(before);
  });

  it('CHK-003 returns 503 and writes nothing when 1Click fails', async () => {
    const body = order();
    fake.setQuoteStatus(500);
    try {
      const response = await create(body);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ type: `${BASE}/problems/quote-unavailable` });
    } finally {
      fake.setQuoteStatus(null);
    }
    const rows = await pool.query('SELECT 1 FROM payments WHERE merchant_id = $1 AND merchant_order_id = $2', [merchantId, body.merchantOrderId]);
    expect(rows.rowCount).toBe(0);
  });

  it('CHK-003 returns 404 for an unknown payment and keeps the default merchant stable', async () => {
    const missing = await app.inject({ method: 'GET', url: `/payments/v1/${randomUUID()}`, headers: { 'x-api-key': merchantKey } });
    expect(missing.statusCode).toBe(404);
    const again = await registerDefaultMerchant(createPostgresMerchantDirectory(pool), merchantKey, () => 'ignored');
    expect(again).toBe(merchantId);
  });
});
