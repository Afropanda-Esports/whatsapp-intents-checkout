import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { KeyPairEd25519 } from 'near-api-js';
import type { Pool } from 'pg';
import { createHttpOneClickGateway } from '../src/adaptors/one-click/http-one-click-gateway.js';
import { createRpcPolicyLedger } from '../src/adaptors/near-rpc/rpc-policy-ledger.js';
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
import { createPaymentFulfilmentService } from '../src/domain/payment/payment-fulfilment-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import { createTrackPayments, type TrackPayments } from '../src/domain/payment/track-payments.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeNearRpc, type FakeNearRpc } from './fakes/fake-near-rpc.js';
import { startFakeOneClick, type FakeOneClick } from './fakes/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-007-${randomUUID()}`;
const AMOUNT_OUT = '1000000';
const REFUND_TO = 'TCustomerRefundAddress';
const TX_HASH = 'FakeTxHash11111111111111111111111111111111';

type Received = { body: string };
type PaymentBody = { paymentId: string; deadline: string; status: string; fulfilledAt: string | null };

describe('CHK-007 policy ledger', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let near: FakeNearRpc;
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  let trackOn: TrackPayments;
  let trackOff: TrackPayments;
  let relay: RelayWebhooks;
  let merchantId: string;
  let posts: Received[];
  let receiver: Server;
  const now = new Date('2026-11-12T00:00:00.000Z');

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
    pool = createPool(databaseUrl, () => {});
    await runMigrations(pool);
    fake = await startFakeOneClick();
    near = await startFakeNearRpc();
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
      settings: {
        treasuryAccountId: 'checkout.afropanda.near',
        destinationAssetId: USDC_NEAR_ASSET_ID,
        paymentWindowMinutes: 30,
        slippageBps: 100,
        checkoutEnabled: true,
      },
    });
    const read = createPaymentReadService({ payments });
    const secret = KeyPairEd25519.fromRandom().secretKey;
    const ledger = createRpcPolicyLedger({
      rpcUrl: near.url,
      contractId: 'policy.test.near',
      operatorAccountId: 'operator.test.near',
      operatorPrivateKey: `ed25519:${secret}`,
    });
    const shared = {
      payments,
      statuses: gateway,
      merchants: directory,
      publicBaseUrl: BASE,
      newEventId: () => randomUUID(),
      clock: () => now,
      onSkip: () => undefined,
    };
    trackOn = createTrackPayments({ ...shared, ledger });
    trackOff = createTrackPayments(shared);
    const fulfilOn = createPaymentFulfilmentService({
      getPayment: (merchant, paymentId) => read.getPayment(merchant, paymentId),
      markFulfilled: (merchant, paymentId) => payments.markFulfilled(merchant, paymentId),
      ledger,
    });
    const fulfilOff = createPaymentFulfilmentService({
      getPayment: (merchant, paymentId) => read.getPayment(merchant, paymentId),
      markFulfilled: (merchant, paymentId) => payments.markFulfilled(merchant, paymentId),
    });
    relay = createRelayWebhooks({
      outbox: createPostgresOutboxStore(pool),
      merchants: directory,
      sender: createHttpWebhookSender(),
      onFifthFailure: () => undefined,
      onError: () => undefined,
    });
    const auth = createMerchantAuth(merchantKey);
    const serverPayments = {
      authenticate: (key: string | undefined) => auth.authenticate(key),
      createPayment: (input: Parameters<typeof create.createPayment>[0]) => create.createPayment(input),
      getPayment: (merchant: string, paymentId: string) => read.getPayment(merchant, paymentId),
      merchantId,
      publicBaseUrl: BASE,
    };
    const logger = createLogger();
    appOn = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger,
      payments: { ...serverPayments, fulfilPayment: (merchant, paymentId) => fulfilOn.fulfil(merchant, paymentId) },
    });
    appOff = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger,
      payments: { ...serverPayments, fulfilPayment: (merchant, paymentId) => fulfilOff.fulfil(merchant, paymentId) },
    });
  });

  afterAll(async () => {
    await appOn?.close();
    await appOff?.close();
    await fake?.close();
    await near?.close();
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

  it('CHK-007 settles without NEAR when the ledger is not configured, and fulfilment is unavailable', async () => {
    near.calls.length = 0;
    const created = await openPayment();
    await settle(trackOff);
    expect(near.calls).toEqual([]);
    expect(onlyPost()).toMatchObject({ type: 'payment.settled', data: { status: 'SETTLED', fulfilledAt: null } });
    const response = await fulfil(appOff, created.paymentId);
    expect(response.statusCode).toBe(503);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: 'Policy unavailable', status: 503 });
    expect(String(body['type'])).toMatch(/\/problems\/policy-unavailable$/u);
    expect(body).not.toHaveProperty('errors');
    expect(typeof body['correlationId']).toBe('string');
    expect((await getPayment(created.paymentId)).fulfilledAt).toBeNull();
  });

  it('CHK-007 registers the settled payment, then marks it fulfilled once', async () => {
    near.calls.length = 0;
    posts.length = 0;
    const created = await openPayment();
    await settle(trackOn);
    expect(near.calls).toContainEqual({
      methodName: 'register_payment',
      args: {
        order_ref: created.paymentId,
        amount_received: AMOUNT_OUT,
        refund_destination: REFUND_TO,
        origin_asset: USDT_TRON_ASSET_ID,
      },
    });
    expect(onlyPost()).toMatchObject({ type: 'payment.settled', data: { fulfilledAt: null, settledAmount: AMOUNT_OUT } });

    const marksBefore = markCalls().length;
    const first = await fulfil(appOn, created.paymentId);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/hal+json');
    expect(first.json<PaymentBody>().fulfilledAt).toEqual(expect.any(String));
    expect(markCalls()).toContainEqual({ methodName: 'mark_fulfilled', args: { order_ref: created.paymentId } });
    expect(markCalls()).toHaveLength(marksBefore + 1);

    const second = await fulfil(appOn, created.paymentId);
    expect(second.statusCode).toBe(200);
    expect(second.json<PaymentBody>().fulfilledAt).toBe(first.json<PaymentBody>().fulfilledAt);
    expect(markCalls()).toHaveLength(marksBefore + 1);
    expect((await getPayment(created.paymentId)).fulfilledAt).toEqual(expect.any(String));
  });

  it('CHK-007 returns the contract panic as policy rejected and leaves fulfilment unset', async () => {
    const created = await openPayment();
    await settle(trackOn);
    near.failNext('E_FULFILLED', TX_HASH);
    const response = await fulfil(appOn, created.paymentId);
    expect(response.statusCode).toBe(422);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: 'Policy rejected', status: 422, code: 'E_FULFILLED', txHash: TX_HASH });
    expect(String(body['type'])).toMatch(/\/problems\/policy-rejected$/u);
    expect(body).not.toHaveProperty('errors');
    expect((await getPayment(created.paymentId)).fulfilledAt).toBeNull();
  });

  it('CHK-007 does not settle a success that has no amount', async () => {
    near.calls.length = 0;
    const created = await openPayment();
    fake.pushStatus(statusBody('SUCCESS', { amountOut: null }));
    await trackOn.trackOnce();
    expect(near.calls).toEqual([]);
    expect((await getPayment(created.paymentId)).status).toBe('AWAITING_DEPOSIT');
  });

  it('CHK-007 rejects a missing key, an unknown payment, and a payment that is not settled', async () => {
    const missingKey = await appOn.inject({ method: 'POST', url: `/payments/v1/${randomUUID()}/fulfilment` });
    expect(missingKey.statusCode).toBe(401);
    expect(missingKey.json()).not.toHaveProperty('errors');

    const unknown = await fulfil(appOn, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(String(unknown.json<Record<string, unknown>>()['type'])).toMatch(/\/problems\/not-found$/u);
    expect(unknown.json()).not.toHaveProperty('errors');

    const created = await openPayment();
    const early = await fulfil(appOn, created.paymentId);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ title: 'Payment is not settled', status: 409 });
    expect(String(early.json<Record<string, unknown>>()['type'])).toMatch(/\/problems\/not-settled$/u);
    expect(early.json()).not.toHaveProperty('errors');
  });

  async function openPayment(): Promise<PaymentBody> {
    const created = await appOn.inject({
      method: 'POST',
      url: '/payments/v1',
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify({
        merchantOrderId: `PPA-${randomUUID().slice(0, 8)}`,
        amountOut: AMOUNT_OUT,
        originAsset: USDT_TRON_ASSET_ID,
        refundTo: REFUND_TO,
      }),
    });
    expect(created.statusCode).toBe(201);
    return created.json<PaymentBody>();
  }

  async function settle(tracker: TrackPayments): Promise<void> {
    posts.length = 0;
    fake.pushStatus(statusBody('SUCCESS'));
    await tracker.trackOnce();
    await relay.relayOnce(now);
  }

  function fulfil(app: FastifyInstance, paymentId: string) {
    return app.inject({
      method: 'POST',
      url: `/payments/v1/${paymentId}/fulfilment`,
      headers: { 'x-api-key': merchantKey },
    });
  }

  async function getPayment(paymentId: string): Promise<PaymentBody> {
    const response = await appOn.inject({
      method: 'GET',
      url: `/payments/v1/${paymentId}`,
      headers: { 'x-api-key': merchantKey },
    });
    expect(response.statusCode).toBe(200);
    return response.json<PaymentBody>();
  }

  function markCalls(): Array<{ methodName: string; args: unknown }> {
    return near.calls.filter((call) => call.methodName === 'mark_fulfilled');
  }

  function onlyPost(): { type: string; data: { status: string; fulfilledAt: string | null; settledAmount: string | null } } {
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error('no webhook');
    return JSON.parse(post.body) as { type: string; data: { status: string; fulfilledAt: string | null; settledAmount: string | null } };
  }
});

function statusBody(status: string, options: { amountOut?: string | null; depositedAmount?: string } = {}) {
  const swapDetails: Record<string, unknown> = {
    intentHashes: [],
    nearTxHashes: [],
    originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
    destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
  };
  if (options.amountOut !== null) swapDetails['amountOut'] = options.amountOut ?? AMOUNT_OUT;
  if (options.depositedAmount !== undefined) swapDetails['depositedAmount'] = options.depositedAmount;
  return {
    correlationId: 'cid-status',
    status,
    updatedAt: '2026-11-12T00:00:00.000Z',
    swapDetails,
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
