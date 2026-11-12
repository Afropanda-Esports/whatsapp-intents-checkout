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
import { createPostgresDisbursementRepository } from '../src/adaptors/postgres/postgres-disbursement-repository.js';
import { createPostgresMerchantDirectory } from '../src/adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresOutboxStore } from '../src/adaptors/postgres/postgres-outbox-store.js';
import { createPostgresPaymentRepository } from '../src/adaptors/postgres/postgres-payment-repository.js';
import { createAssetService } from '../src/domain/asset/asset-service.js';
import { createRefundService } from '../src/domain/disbursement/refund-service.js';
import { registerDefaultMerchant } from '../src/domain/merchant/default-merchant.js';
import { createMerchantAuth } from '../src/domain/merchant/merchant-auth-service.js';
import { createRelayWebhooks, type RelayWebhooks } from '../src/domain/notification/relay-webhooks.js';
import { createPaymentCreationService } from '../src/domain/payment/payment-creation-service.js';
import { createPaymentReadService } from '../src/domain/payment/payment-read-service.js';
import { createTrackPayments, type TrackPayments } from '../src/domain/payment/track-payments.js';
import { createLogger } from '../src/logging.js';
import { USDT_TRON_ASSET_ID } from '../unit_test/fixtures/tokens.js';
import { USDC_NEAR_ASSET_ID } from '../unit_test/fixtures/quotes.js';
import { startFakeNearRpc, type FakeNearRpc } from '../src/adaptors/fake/fake-near-rpc.js';
import { startFakeOneClick, type FakeOneClick } from '../src/adaptors/fake/fake-one-click-http.js';

const BASE = 'https://checkout.example';
const merchantKey = `chk-008-${randomUUID()}`;
const AMOUNT_OUT = '1000000';
const REFUND_AMOUNT = '500000';
const REFUND_TO = 'TCustomerRefundAddress';
const TX_HASH = 'FakeTxHash22222222222222222222222222222222';

type Received = { body: string };
type PaymentBody = { paymentId: string; status: string; refundedAmount: string; fulfilledAt: string | null };
type RefundBody = { refundId: string; paymentId: string; status: string; amount: string; reason: string };

describe('CHK-008 refunds', () => {
  let pool: Pool;
  let fake: FakeOneClick;
  let near: FakeNearRpc;
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  let track: TrackPayments;
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
    const disbursements = createPostgresDisbursementRepository(pool);
    const settings = {
      treasuryAccountId: 'checkout.afropanda.near',
      destinationAssetId: USDC_NEAR_ASSET_ID,
      paymentWindowMinutes: 30,
      slippageBps: 100,
      checkoutEnabled: true,
    };
    const create = createPaymentCreationService({
      quotes: gateway,
      assets: createAssetService({ tokens: gateway, clock: () => Date.now() }),
      payments,
      clock: () => now,
      settings,
    });
    const read = createPaymentReadService({ payments });
    const secret = KeyPairEd25519.fromRandom().secretKey;
    const ledger = createRpcPolicyLedger({
      rpcUrl: near.url,
      contractId: 'policy.test.near',
      operatorAccountId: 'operator.test.near',
      operatorPrivateKey: `ed25519:${secret}`,
    });
    track = createTrackPayments({
      payments,
      statuses: gateway,
      merchants: directory,
      publicBaseUrl: BASE,
      newEventId: () => randomUUID(),
      clock: () => now,
      ledger,
      onSkip: () => undefined,
    });
    const refundOn = createRefundService({
      getPayment: (merchant, paymentId) => read.getPayment(merchant, paymentId),
      disbursements,
      quotes: gateway,
      ledger,
      clock: () => now,
      newId: () => randomUUID(),
      publicBaseUrl: BASE,
      settings,
    });
    const refundOff = createRefundService({
      getPayment: (merchant, paymentId) => read.getPayment(merchant, paymentId),
      disbursements,
      quotes: gateway,
      clock: () => now,
      newId: () => randomUUID(),
      publicBaseUrl: BASE,
      settings,
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
      payments: {
        ...serverPayments,
        requestRefund: (merchant, paymentId, input) => refundOn.request(merchant, paymentId, input),
        listRefunds: (merchant, paymentId) => refundOn.list(merchant, paymentId),
      },
    });
    appOff = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger,
      payments: {
        ...serverPayments,
        requestRefund: (merchant, paymentId, input) => refundOff.request(merchant, paymentId, input),
        listRefunds: (merchant, paymentId) => refundOff.list(merchant, paymentId),
      },
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
      await pool.query(
        'DELETE FROM disbursements WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)',
        [merchantId],
      );
      await pool.query('DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [
        merchantId,
      ]);
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
    await pool?.end();
  });

  it('CHK-008 completes an approved refund and increases refundedAmount', async () => {
    near.calls.length = 0;
    const created = await settlePayment();
    const response = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(response.statusCode).toBe(202);
    expect(response.headers['content-type']).toContain('application/hal+json');
    const body = response.json<RefundBody>();
    expect(body).toMatchObject({ paymentId: created.paymentId, status: 'COMPLETED', amount: REFUND_AMOUNT, reason: 'customer returned the order' });
    expect(methodArgs('request_refund')).toContainEqual({ order_ref: created.paymentId, amount: REFUND_AMOUNT });
    const executed = methodArgs('execute_refund');
    expect(executed).toEqual([{ request_id: '1', deposit_address: expect.stringMatching(/^TFakeDeposit/u) }]);
    await relay.relayOnce(now);
    expect(onlyPost()).toMatchObject({ type: 'refund.completed', data: { status: 'COMPLETED', amount: REFUND_AMOUNT } });
    const payment = await getPayment(created.paymentId);
    expect(payment.status).toBe('SETTLED');
    expect(payment.refundedAmount).toBe(REFUND_AMOUNT);
    const listed = await appOn.inject({
      method: 'GET',
      url: `/payments/v1/${created.paymentId}/refunds`,
      headers: { 'x-api-key': merchantKey },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ _embedded: { refunds: RefundBody[] } }>()._embedded.refunds).toEqual([
      expect.objectContaining({ refundId: body.refundId, status: 'COMPLETED' }),
    ]);
  });

  it('CHK-008 refuses a quote whose recipient is not the stored destination', async () => {
    near.calls.length = 0;
    const created = await settlePayment();
    fake.setQuoteRecipient('not-the-customer');
    const response = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(response.statusCode).toBe(409);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: 'Refund not allowed', status: 409, refundableAmount: AMOUNT_OUT });
    expect(String(body['type'])).toMatch(/\/problems\/refund-not-allowed$/u);
    expect(body).not.toHaveProperty('errors');
    expect(methodArgs('request_refund')).toEqual([]);
    expect(methodArgs('execute_refund')).toEqual([]);
    expect((await getPayment(created.paymentId)).refundedAmount).toBe('0');
  });

  it('CHK-008 returns a contract rejection without changing refundedAmount', async () => {
    const created = await settlePayment();
    near.failNext('E_AMOUNT_EXCEEDS_RECEIVED', TX_HASH);
    const response = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(response.statusCode).toBe(422);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: 'Policy rejected', status: 422, code: 'E_AMOUNT_EXCEEDS_RECEIVED', txHash: TX_HASH });
    expect(body).not.toHaveProperty('errors');
    expect((await getPayment(created.paymentId)).refundedAmount).toBe('0');
  });

  it('CHK-008 registers storage for an unregistered deposit address before requesting the refund', async () => {
    near.calls.length = 0;
    const created = await settlePayment();
    near.unregisteredNext();
    const response = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(response.statusCode).toBe(202);
    const names = near.calls.map((call) => call.methodName);
    expect(names.indexOf('storage_deposit')).toBeGreaterThan(-1);
    expect(names.indexOf('storage_deposit')).toBeLessThan(names.indexOf('request_refund'));
    expect(created.paymentId).toEqual(expect.any(String));
  });

  it('CHK-008 stores an escalated refund and does not execute it', async () => {
    near.calls.length = 0;
    posts.length = 0;
    const created = await settlePayment();
    posts.length = 0;
    near.escalateNext();
    const response = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(response.statusCode).toBe(202);
    expect(response.json<RefundBody>().status).toBe('ESCALATED');
    expect(methodArgs('execute_refund')).toEqual([]);
    await relay.relayOnce(now);
    expect(posts).toEqual([]);
    expect((await getPayment(created.paymentId)).refundedAmount).toBe('0');
  });

  it('CHK-008 rejects a missing key, an unknown payment, a payment that is not settled, and a ledger that is off', async () => {
    const missingKey = await appOn.inject({
      method: 'POST',
      url: `/payments/v1/${randomUUID()}/refunds`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: REFUND_AMOUNT, reason: 'missing key' }),
    });
    expect(missingKey.statusCode).toBe(401);
    expect(missingKey.json()).not.toHaveProperty('errors');

    const unknown = await refund(appOn, randomUUID(), REFUND_AMOUNT);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).not.toHaveProperty('errors');

    const settled = await settlePayment();
    const off = await refund(appOff, settled.paymentId, REFUND_AMOUNT);
    expect(off.statusCode).toBe(503);
    expect(String(off.json<Record<string, unknown>>()['type'])).toMatch(/\/problems\/policy-unavailable$/u);
    expect(typeof off.json<Record<string, unknown>>()['correlationId']).toBe('string');

    const created = await openPayment();
    const early = await refund(appOn, created.paymentId, REFUND_AMOUNT);
    expect(early.statusCode).toBe(409);
    const body = early.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: 'Refund not allowed', refundableAmount: '0' });
    expect(body).not.toHaveProperty('errors');
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

  async function settlePayment(): Promise<PaymentBody> {
    const created = await openPayment();
    fake.pushStatus(statusBody('SUCCESS'));
    await track.trackOnce();
    await relay.relayOnce(now);
    posts.length = 0;
    return created;
  }

  function refund(app: FastifyInstance, paymentId: string, amount: string) {
    return app.inject({
      method: 'POST',
      url: `/payments/v1/${paymentId}/refunds`,
      headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
      payload: JSON.stringify({ amount, reason: 'customer returned the order' }),
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

  function methodArgs(methodName: string): unknown[] {
    return near.calls.filter((call) => call.methodName === methodName).map((call) => call.args);
  }

  function onlyPost(): { type: string; data: { status: string; amount: string } } {
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error('no webhook');
    return JSON.parse(post.body) as { type: string; data: { status: string; amount: string } };
  }
});

function statusBody(status: string) {
  return {
    correlationId: 'cid-status',
    status,
    updatedAt: '2026-11-12T00:00:00.000Z',
    swapDetails: {
      amountOut: AMOUNT_OUT,
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://tronscan.org/#/transaction/origin-hash' }],
      destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://nearblocks.io/txns/near-hash' }],
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
