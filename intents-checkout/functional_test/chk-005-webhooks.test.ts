import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { runMigrations } from '../src/adaptors/postgres/migrate.js';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from '../src/adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresOutboxStore } from '../src/adaptors/postgres/postgres-outbox-store.js';
import { createPostgresPaymentRepository } from '../src/adaptors/postgres/postgres-payment-repository.js';
import { createHttpWebhookSender } from '../src/adaptors/http-webhook/http-webhook-sender.js';
import { createAssetService } from '../src/domain/asset/asset-service.js';
import { registerDefaultMerchant } from '../src/domain/merchant/default-merchant.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createRelayWebhooks, type RelayWebhooks } from '../src/domain/notification/relay-webhooks.js';
import { createPaymentCreationService } from '../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import { createTrackPayments, type TrackPayments } from '../src/domain/payment/track-payments.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeOneClick, type FakeOneClick } from '../src/adaptors/fake/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-005-${randomUUID()}`;
const WEBHOOK_SECRET = 'chk-005-secret';
const AMOUNT_OUT = '1000000';

type Received = { body: string; signature: string | undefined };

describe('CHK-005 webhooks', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let app: FastifyInstance;
  let track: TrackPayments;
  let relay: RelayWebhooks;
  let merchantId: string;
  let posts: Received[];
  let receiverStatus: { value: number };
  let receiver: Server;

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
    pool = createPool(databaseUrl, () => {});
    await runMigrations(pool);
    fake = await startFakeOneClick();
    const listening = await startReceiver();
    posts = listening.posts;
    receiverStatus = listening.status;
    receiver = listening.server;
    const directory = createPostgresMerchantDirectory(pool);
    const id = await registerDefaultMerchant(directory, merchantKey, () => WEBHOOK_SECRET);
    if (id === undefined) throw new Error('no merchant');
    merchantId = id;
    await directory.setWebhookUrl(merchantId, listening.url);
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
        checkoutEnabled: true,
      },
    });
    const read = createPaymentReadService({ payments });
    track = createTrackPayments({
      payments,
      statuses: gateway,
      merchants: directory,
      publicBaseUrl: BASE,
      newEventId: () => randomUUID(),
      clock: () => new Date(),
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

  it('CHK-005 delivers payment.settled once with a valid signature', async () => {
    posts.length = 0;
    receiverStatus.value = 200;
    const now = new Date();
    await settle(randomUUID().slice(0, 8));
    await relay.relayOnce(now);
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error('no webhook');
    const body = JSON.parse(post.body) as { eventId: string; type: string; data: { status: string; settledAmount: string } };
    expect(body.type).toBe('payment.settled');
    expect(body.data.status).toBe('SETTLED');
    expect(body.data.settledAmount).toBe(AMOUNT_OUT);
    expect(signed(post.signature, post.body)).toBe(true);
    const stored = await latestOutbox();
    expect(stored.id).toBe(body.eventId);
    expect(stored.delivered_at).not.toBeNull();

    await track.trackOnce();
    await relay.relayOnce(new Date());
    expect(posts).toHaveLength(1);
  });

  it('CHK-005 retries a failed receiver with the same event and body', async () => {
    posts.length = 0;
    receiverStatus.value = 500;
    const now = new Date();
    await settle(randomUUID().slice(0, 8));
    await relay.relayOnce(now);
    expect(posts).toHaveLength(1);
    const failed = await latestOutbox();
    expect(failed.attempts).toBe(1);
    expect(failed.delivered_at).toBeNull();

    await relay.relayOnce(now);
    expect(posts).toHaveLength(1);

    receiverStatus.value = 200;
    await relay.relayOnce(new Date(now.getTime() + 30_000));
    expect(posts).toHaveLength(2);
    const first = posts[0];
    const second = posts[1];
    if (first === undefined || second === undefined) throw new Error('missing retry');
    expect(second.body).toBe(first.body);
    const eventId = (JSON.parse(first.body) as { eventId: string }).eventId;
    expect((JSON.parse(second.body) as { eventId: string }).eventId).toBe(eventId);
    expect(signed(second.signature, second.body)).toBe(true);
    const delivered = await latestOutbox();
    expect(delivered.delivered_at).not.toBeNull();
  });

  it('GET without a key is still unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: `/payments/v1/${randomUUID()}` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401 });
    expect(response.json()).not.toHaveProperty('errors');
  });

  async function settle(suffix: string): Promise<void> {
    const created = await app.inject({
      method: 'POST',
      url: '/payments/v1',
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify({
        merchantOrderId: `PPA-${suffix}`,
        amountOut: AMOUNT_OUT,
        originAsset: USDT_TRON_ASSET_ID,
        refundTo: 'TCustomerRefundAddress',
      }),
    });
    expect(created.statusCode).toBe(201);
    fake.pushStatus(statusBody());
    await track.trackOnce();
  }

  async function latestOutbox(): Promise<{ id: string; attempts: number; delivered_at: Date | null }> {
    const result = await pool.query<{ id: string; attempts: number; delivered_at: Date | null }>(
      `SELECT id::text, attempts, delivered_at
       FROM outbox_events WHERE merchant_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [merchantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('no outbox row');
    return row;
  }
});

function statusBody() {
  return {
    correlationId: 'cid-status',
    status: 'SUCCESS',
    updatedAt: '2026-11-11T00:00:00.000Z',
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
      destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
      amountOut: AMOUNT_OUT,
      depositedAmount: '15082000',
    },
  };
}

function signed(signature: string | undefined, body: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/u.exec(signature ?? '');
  if (match === null) return false;
  const timestamp = match[1];
  const given = match[2];
  if (timestamp === undefined || given === undefined) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return given === expected;
}

function startReceiver(): Promise<{ url: string; posts: Received[]; status: { value: number }; server: Server }> {
  const posts: Received[] = [];
  const status = { value: 200 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const header = req.headers['x-checkout-signature'];
      posts.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: Array.isArray(header) ? header[0] : header,
      });
      res.writeHead(status.value).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}/hooks`, posts, status, server });
    });
  });
}
