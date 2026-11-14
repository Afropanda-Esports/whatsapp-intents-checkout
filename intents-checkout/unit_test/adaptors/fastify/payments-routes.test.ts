import { describe, expect, it, vi } from 'vitest';
import { buildServer, type ServerDeps } from '../../../src/adaptors/fastify/server.js';
import { DomainError } from '../../../src/domain/domain-error.js';
import { createMerchantAuth } from '../../../src/domain/merchant/merchant-auth-service.js';
import type { Payment } from '../../../src/domain/payment/types.js';
import { createLogger } from '../../../src/logging.js';

const KEY = 'merchant-key';
const BASE = 'https://checkout.example';
const MERCHANT = '7b1c3c3e-8d3f-4a7a-9d11-000000000001';
const ID = '5f0b7c1e-2f3a-4c55-9a51-1c8e2a6d9f10';

const payment: Payment = {
  id: ID,
  merchantId: MERCHANT,
  merchantOrderId: 'PPA-1',
  status: 'AWAITING_DEPOSIT',
  originAsset: 'nep141:tron-usdt',
  destinationAsset: 'nep141:usdc',
  amountOut: '1000000',
  amountIn: '1010203',
  minAmountIn: '1000101',
  refundFee: '2400',
  depositAddress: 'TDeposit1',
  depositMemo: null,
  refundTo: 'TCustomer',
  confidential: false,
  deadline: '2026-11-10T01:30:00.000Z',
  depositedAmount: null,
  settledAmount: null,
  refundedAmount: '0',
  fulfilledAt: null,
  originTxHashes: [],
  destinationTxHashes: [],
  createdAt: '2026-11-10T01:00:00.000Z',
  updatedAt: '2026-11-10T01:00:00.000Z',
};

const body = { merchantOrderId: 'PPA-1', amountOut: '1000000', originAsset: 'nep141:tron-usdt', refundTo: 'TCustomer' };

async function server(overrides: Partial<NonNullable<ServerDeps['payments']>> = {}) {
  const createPayment = vi.fn(async () => ({ payment, created: true }));
  const getPayment = vi.fn(async () => payment);
  const auth = createMerchantAuth(KEY);
  const app = await buildServer({
    checkLive: () => ({ status: 'live' }),
    checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
    logger: createLogger(),
    payments: {
      authenticate: (key) => auth.authenticate(key),
      createPayment,
      getPayment,
      merchantId: MERCHANT,
      publicBaseUrl: BASE,
      ...overrides,
    },
  });
  return { app, createPayment, getPayment };
}

function post(payload: unknown, headers: Record<string, string> = { 'x-api-key': KEY }) {
  return { method: 'POST' as const, url: '/payments/v1', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) };
}

describe('POST /payments/v1', () => {
  it('201 with the HAL payment and an absolute self link', async () => {
    const { app, createPayment } = await server();
    const response = await app.inject(post(body));
    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/hal+json');
    const json = response.json<Record<string, unknown>>();
    expect(json).toMatchObject({
      paymentId: ID,
      merchantOrderId: 'PPA-1',
      status: 'AWAITING_DEPOSIT',
      amountOut: '1000000',
      amountIn: '1010203',
      minAmountIn: '1000101',
      refundFee: '2400',
      depositAddress: 'TDeposit1',
      depositMemo: null,
      deadline: '2026-11-10T01:30:00.000Z',
      confidential: false,
      depositedAmount: null,
      settledAmount: null,
      refundedAmount: '0',
      fulfilledAt: null,
      _links: { self: { href: `${BASE}/payments/v1/${ID}` } },
    });
    expect(response.body.indexOf('"minAmountIn"')).toBeLessThan(response.body.indexOf('"refundFee"'));
    expect(response.body.indexOf('"refundFee"')).toBeLessThan(response.body.indexOf('"depositAddress"'));
    expect(json).not.toHaveProperty('merchantId');
    expect(json).not.toHaveProperty('refundTo', undefined);
    expect(createPayment).toHaveBeenCalledWith({ merchantId: MERCHANT, ...body });
  });

  it('200 when the payment already existed', async () => {
    const { app } = await server({ createPayment: vi.fn(async () => ({ payment, created: false })) });
    expect((await app.inject(post(body))).statusCode).toBe(200);
  });

  it('401 problem without a key, and the service is not called', async () => {
    const { app, createPayment } = await server();
    const response = await app.inject(post(body, {}));
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/unauthorized`, status: 401 });
    expect(createPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing field', { ...body, refundTo: undefined }],
    ['an unknown field', { ...body, extra: 1 }],
    ['a numeric amount', { ...body, amountOut: 1000000 }],
    ['an over-long order id', { ...body, merchantOrderId: 'x'.repeat(65) }],
  ])('400 invalid-request with errors[] for %s', async (_name, payload) => {
    const { app, createPayment } = await server();
    const response = await app.inject(post(payload));
    expect(response.statusCode).toBe(400);
    const json = response.json<{ type: string; errors: Array<{ path: string; message: string }> }>();
    expect(json.type).toBe(`${BASE}/problems/invalid-request`);
    expect(json.errors.length).toBeGreaterThan(0);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('400 invalid-request problem for malformed JSON', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'POST', url: '/payments/v1', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, payload: '{"nope' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/invalid-request`, status: 400 });
  });

  it.each([
    [new DomainError('invalid-request', { errors: [{ path: 'amountOut', message: 'must be a positive base-unit integer' }] }), 400, 'invalid-request'],
    [new DomainError('order-conflict', { paymentId: ID }), 409, 'order-conflict'],
    [new DomainError('unsupported-asset', { originAsset: 'nep141:x' }), 422, 'unsupported-asset'],
    [new DomainError('quote-rejected', { reason: 'bad refundTo' }), 422, 'quote-rejected'],
    [new DomainError('quote-unavailable'), 503, 'quote-unavailable'],
  ])('maps %s to %i', async (error, status, type) => {
    const { app } = await server({ createPayment: vi.fn(async () => Promise.reject(error)) });
    const response = await app.inject(post(body, { 'x-api-key': KEY, 'x-request-id': 'cid-1' }));
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/${type}`, status, ...error.details });
    if (status === 503) expect(response.json()).toMatchObject({ correlationId: 'cid-1' });
  });

  it('500 problem for an unexpected error, without leaking its message', async () => {
    const { app } = await server({ createPayment: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED secret-host'))) });
    const response = await app.inject(post(body));
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/internal`, status: 500 });
    expect(response.body).not.toContain('secret-host');
  });
});

describe('GET /payments/v1/:paymentId', () => {
  it('200 with the same HAL body', async () => {
    const { app, getPayment } = await server();
    const response = await app.inject({ method: 'GET', url: `/payments/v1/${ID}`, headers: { 'x-api-key': KEY } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/hal+json');
    expect(response.json()).toMatchObject({ paymentId: ID, _links: { self: { href: `${BASE}/payments/v1/${ID}` } } });
    expect(getPayment).toHaveBeenCalledWith(MERCHANT, ID);
  });

  it('404 not-found problem', async () => {
    const { app } = await server({ getPayment: vi.fn(async () => Promise.reject(new DomainError('not-found'))) });
    const response = await app.inject({ method: 'GET', url: `/payments/v1/${ID}`, headers: { 'x-api-key': KEY } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ type: `${BASE}/problems/not-found`, status: 404 });
  });

  it('401 without a key', async () => {
    const { app } = await server();
    expect((await app.inject({ method: 'GET', url: `/payments/v1/${ID}` })).statusCode).toBe(401);
  });
});

describe('payments without a merchant', () => {
  it('rejects every request as unauthorized when no default merchant exists', async () => {
    const { app, createPayment } = await server({ merchantId: undefined });
    expect((await app.inject(post(body))).statusCode).toBe(401);
    expect(createPayment).not.toHaveBeenCalled();
  });
});
