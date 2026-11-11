import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { runMigrations } from '../src/adaptors/postgres/migrate.js';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from '../src/adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresPaymentRepository } from '../src/adaptors/postgres/postgres-payment-repository.js';
import { createAssetService } from '../src/domain/asset/asset-service.js';
import { registerDefaultMerchant } from '../src/domain/merchant/default-merchant.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createPaymentCreationService } from '../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import { createTrackPayments, type TrackPayments } from '../src/domain/payment/track-payments.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeOneClick, type FakeOneClick } from './fakes/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-004-${randomUUID()}`;
const AMOUNT_OUT = '1000000';

function statusBody(status: string) {
  return {
    correlationId: 'cid-status',
    status,
    updatedAt: '2026-11-11T00:00:00.000Z',
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
      destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
      amountOut: AMOUNT_OUT,
      depositedAmount: '15082000',
      amountOutUsd: '1.00',
    },
  };
}

describe('CHK-004 track payments', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let app: FastifyInstance;
  let track: TrackPayments;
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
    track = createTrackPayments({
      payments,
      statuses: gateway,
      clock: () => new Date(),
      onSkip: () => undefined,
    });
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
      await pool.query('DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [
        merchantId,
      ]);
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
    await pool?.end();
  });

  async function eventCount(paymentId: string): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM payment_events WHERE payment_id = $1', [
      paymentId,
    ]);
    return Number(result.rows[0]?.count ?? '0');
  }

  it('CHK-004 follows the status sequence to SETTLED and keeps the hashes on GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/payments/v1',
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify({
        merchantOrderId: `PPA-${randomUUID().slice(0, 8)}`,
        amountOut: AMOUNT_OUT,
        originAsset: USDT_TRON_ASSET_ID,
        refundTo: 'TCustomerRefundAddress',
      }),
    });
    expect(created.statusCode).toBe(201);
    const paymentId = created.json<{ paymentId: string }>().paymentId;

    for (const status of ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS']) {
      fake.pushStatus(statusBody(status));
      await track.trackOnce();
    }

    const settled = await app.inject({
      method: 'GET',
      url: `/payments/v1/${paymentId}`,
      headers: { 'x-api-key': merchantKey },
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({
      status: 'SETTLED',
      settledAmount: AMOUNT_OUT,
      depositedAmount: '15082000',
      originTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
      destinationTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
    });
    expect(JSON.stringify(settled.json())).not.toContain('amountOutUsd');

    const events = await eventCount(paymentId);
    await track.trackOnce();
    expect(await eventCount(paymentId)).toBe(events);
  });

  it('CHK-004 leaves the payment awaiting deposit when status cannot be read', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/payments/v1',
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify({
        merchantOrderId: `PPA-${randomUUID().slice(0, 8)}`,
        amountOut: AMOUNT_OUT,
        originAsset: USDT_TRON_ASSET_ID,
        refundTo: 'TCustomerRefundAddress',
      }),
    });
    const paymentId = created.json<{ paymentId: string }>().paymentId;
    fake.pushStatus(500);
    await track.trackOnce();
    const still = await app.inject({
      method: 'GET',
      url: `/payments/v1/${paymentId}`,
      headers: { 'x-api-key': merchantKey },
    });
    expect(still.statusCode).toBe(200);
    expect(still.json()).toMatchObject({ status: 'AWAITING_DEPOSIT', settledAmount: null });
  });

  it('GET without a key is still unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: `/payments/v1/${randomUUID()}` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401 });
    expect(response.json()).not.toHaveProperty('errors');
  });
});
