import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { createHttpWebhookSender } from '../src/adaptors/http-webhook/http-webhook-sender.js';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { runMigrations } from '../src/adaptors/postgres/migrate.js';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from '../src/adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresOutboxStore } from '../src/adaptors/postgres/postgres-outbox-store.js';
import { createPostgresPaymentRepository } from '../src/adaptors/postgres/postgres-payment-repository.js';
import { createAssetService } from '../src/domain/asset/asset-service.js';
import { registerDefaultMerchant } from '../src/domain/merchant/default-merchant.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createRelayWebhooks, type RelayWebhooks } from '../src/domain/notification/relay-webhooks.js';
import { createPaymentCreationService } from '../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import type { PaymentSettings } from '../src/domain/payment/payment-service-deps.js';
import { createTrackPayments, type TrackPayments } from '../src/domain/payment/track-payments.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeOneClick, type FakeOneClick } from '../src/adaptors/fake/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-006-${randomUUID()}`;
const AMOUNT_OUT = '1000000';
const MIN_AMOUNT_IN = '1000101';

type Received = { body: string };

describe('CHK-006 failure paths', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let app: FastifyInstance;
  let track: TrackPayments;
  let relay: RelayWebhooks;
  let merchantId: string;
  let posts: Received[];
  let receiver: Server;
  let now = new Date('2026-11-12T00:00:00.000Z');
  const settings: PaymentSettings = {
    treasuryAccountId: 'checkout.afropanda.near',
    destinationAssetId: USDC_NEAR_ASSET_ID,
    paymentWindowMinutes: 30,
    slippageBps: 100,
    checkoutEnabled: true,
  };

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
    pool = createPool(databaseUrl, () => {});
    await runMigrations(pool);
    fake = await startFakeOneClick();
    const listening = await startReceiver();
    posts = listening.posts;
    receiver = listening.server;
    const directory = createPostgresMerchantDirectory(pool);
    const id = await registerDefaultMerchant(directory, merchantKey, () => randomUUID());
    if (id === undefined) throw new Error('no merchant');
    merchantId = id;
    await directory.setWebhookUrl(merchantId, listening.url);
    const gateway = createHttpOneClickGateway({ baseUrl: fake.url });
    const payments = createPostgresPaymentRepository(pool);
    const create = createPaymentCreationService({
      quotes: gateway,
      assets: createAssetService({ tokens: gateway, clock: () => Date.now() }),
      payments,
      clock: () => now,
      settings,
    });
    const read = createPaymentReadService({ payments });
    track = createTrackPayments({
      payments,
      statuses: gateway,
      merchants: directory,
      publicBaseUrl: BASE,
      newEventId: () => randomUUID(),
      clock: () => now,
      onSkip: () => undefined,
    });
    relay = createRelayWebhooks({
      outbox: createPostgresOutboxStore(pool),
      merchants: directory,
      sender: createHttpWebhookSender(),
      onFifthFailure: () => undefined,
      onFailure: () => undefined,
      onError: () => undefined,
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
    if (receiver !== undefined) {
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
    if (pool !== undefined && merchantId !== undefined) {
      await pool.query('DELETE FROM outbox_events WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [
        merchantId,
      ]);
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
    await pool?.end();
  });

  it('CHK-006 delivers payment.expired after the deadline', async () => {
    const created = await openPayment();
    now = new Date(Date.parse(created.deadline) + 1);
    await notify('PENDING_DEPOSIT', 'payment.expired', 'EXPIRED');
  });

  it('CHK-006 delivers payment.underpaid with both amounts', async () => {
    posts.length = 0;
    await openPayment();
    fake.pushStatus(statusBody('INCOMPLETE_DEPOSIT', '500000'));
    await track.trackOnce();
    await relay.relayOnce(now);
    const body = onlyPost();
    expect(body.type).toBe('payment.underpaid');
    expect(body.data).toMatchObject({ status: 'UNDERPAID', depositedAmount: '500000', minAmountIn: MIN_AMOUNT_IN });
  });

  it('CHK-006 delivers payment.returned and payment.failed', async () => {
    await openPayment();
    await notify('REFUNDED', 'payment.returned', 'RETURNED');
    await openPayment();
    await notify('FAILED', 'payment.failed', 'FAILED');
  });

  it('CHK-006 refuses a new payment when checkout is disabled', async () => {
    await openPayment();
    settings.checkoutEnabled = false;
    try {
      posts.length = 0;
      fake.pushStatus(statusBody('FAILED'));
      await track.trackOnce();
      await relay.relayOnce(now);
      expect(onlyPost()).toMatchObject({ type: 'payment.failed', data: { status: 'FAILED' } });

      const quotes = fake.quoteBodies.length;
      const refused = await app.inject({
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
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ title: 'Checkout disabled', status: 503 });
      expect(String(refused.json().type)).toMatch(/\/problems\/checkout-disabled$/u);
      expect(refused.json()).not.toHaveProperty('errors');
      expect(fake.quoteBodies).toHaveLength(quotes);
    } finally {
      settings.checkoutEnabled = true;
    }
  });

  it('GET without a key is still unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: `/payments/v1/${randomUUID()}` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401 });
    expect(response.json()).not.toHaveProperty('errors');
  });

  async function openPayment(): Promise<{ deadline: string }> {
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
    return created.json<{ deadline: string }>();
  }

  async function notify(oneClickStatus: string, type: string, status: string): Promise<void> {
    posts.length = 0;
    fake.pushStatus(statusBody(oneClickStatus));
    await track.trackOnce();
    await relay.relayOnce(now);
    expect(onlyPost()).toMatchObject({ type, data: { status } });
  }

  function onlyPost(): { type: string; data: { status: string; depositedAmount: string | null; minAmountIn: string } } {
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error('no webhook');
    return JSON.parse(post.body) as { type: string; data: { status: string; depositedAmount: string | null; minAmountIn: string } };
  }
});

function statusBody(status: string, depositedAmount?: string) {
  return {
    correlationId: 'cid-status',
    status,
    updatedAt: '2026-11-12T00:00:00.000Z',
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
      destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
      amountOut: AMOUNT_OUT,
      ...(depositedAmount === undefined ? {} : { depositedAmount }),
    },
  };
}

function startReceiver(): Promise<{ url: string; posts: Received[]; server: Server }> {
  const posts: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      posts.push({ body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}/hooks`, posts, server });
    });
  });
}
