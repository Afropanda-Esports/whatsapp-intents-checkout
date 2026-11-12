import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { USDT_TRON_ASSET_ID } from '../src/adaptors/fake/tokens.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const merchantKey = `chk-016-${randomUUID()}`;
const AMOUNT_OUT = '1000000';
const REFUND_AMOUNT = '500000';
const REFUND_TO = 'TCustomerRefundAddress';
const REFUND_REASON = 'customer returned the order';

type PaymentBody = { paymentId: string; status: string; depositAddress: string };
type RefundBody = { refundId: string; status: string; amount: string; reason: string };

describe('CHK-016 judge mode', () => {
  let pool: Pool | undefined;
  let child: ChildProcess | undefined;
  let port = 0;
  let merchantId: string | undefined;
  let posts: string[] = [];
  let closeReceiver: (() => Promise<void>) | undefined;
  const output: string[] = [];

  beforeAll(async () => {
    const databaseUrl = requireDatabaseUrl();
    const listening = await startReceiver();
    posts = listening.posts;
    closeReceiver = listening.close;
    port = await freePort();
    const env = serviceEnv(databaseUrl, port, listening.url);
    expect(env['CHECKOUT_MODE']).toBe('fake');
    expect(env['ONE_CLICK_BASE_URL']).toBeUndefined();
    expect(env['NEAR_RPC_URL']).toBeUndefined();
    expect(env['POLICY_CONTRACT_ID']).toBeUndefined();
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => output.push(chunk));
    child.stderr?.on('data', (chunk: string) => output.push(chunk));
    await waitForReady(port, () => output.join(''));
    pool = createPool(databaseUrl, () => {});
    const found = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE api_key_hash = $1', [hashKey(merchantKey)]);
    merchantId = found.rows[0]?.id;
  }, 30_000);

  afterAll(async () => {
    await stopChild(child);
    if (closeReceiver !== undefined) await closeReceiver();
    const databaseUrl = process.env['DATABASE_URL'];
    const cleanup = pool ?? (databaseUrl === undefined || databaseUrl.length === 0 ? undefined : createPool(databaseUrl, () => {}));
    if (cleanup !== undefined) {
      await deleteMerchant(cleanup, merchantId ?? (await merchantIdFor(cleanup, merchantKey)));
      if (cleanup !== pool) await cleanup.end();
    }
    await pool?.end();
  });

  it(
    'CHK-016 settles a payment, completes a refund, and delivers a webhook with no mainnet URL',
    async () => {
      const logs = output.join('');
      expect(logs).toContain('merchant api key');
      expect(logs).toContain(merchantKey);
      expect(logs).not.toContain('1click.chaindefuser.com');
      expect(logs).not.toContain('mainnet.near');

      const created = await createPayment(port);
      expect(created.depositAddress).toMatch(/^TFakeDeposit/u);
      expect(created.status).toBe('AWAITING_DEPOSIT');

      const settled = await waitForStatus(port, created.paymentId, 'SETTLED');
      expect(settled.status).toBe('SETTLED');

      const refund = await requestRefund(port, created.paymentId);
      expect(refund.status).toBe('COMPLETED');
      expect(refund.amount).toBe(REFUND_AMOUNT);
      expect(refund.reason).toBe(REFUND_REASON);

      const delivered = await waitForWebhook(posts, () => output.join(''));
      expect(delivered).toMatch(/payment\.settled|refund\.completed/u);
      const matching = posts.filter((body) => body.includes('payment.settled') || body.includes('refund.completed'));
      expect(matching.length).toBeGreaterThanOrEqual(1);
    },
    70_000,
  );

  it('CHK-016 does not log the merchant key in live mode', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: projectRoot,
      env: {
        PATH: process.env['PATH'],
        PORT: '3996',
        CHECKOUT_MODE: 'live',
        MERCHANT_API_KEY: 'judge-merchant-key',
        DATABASE_URL: 'postgres://postgres:s3cret@127.0.0.1:1/intents_checkout',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    const logs = `${result.stdout}${result.stderr}`;
    expect(logs).not.toContain('judge-merchant-key');
    expect(logs).not.toContain('merchant api key');
    expect(logs).not.toContain('s3cret');
  });
});

function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
  return databaseUrl;
}

function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

async function merchantIdFor(pool: Pool, apiKey: string): Promise<string | undefined> {
  const found = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE api_key_hash = $1', [hashKey(apiKey)]);
  return found.rows[0]?.id;
}

async function deleteMerchant(pool: Pool, id: string | undefined): Promise<void> {
  if (id === undefined) return;
  await pool.query('DELETE FROM outbox_events WHERE merchant_id = $1', [id]);
  await pool.query('DELETE FROM disbursements WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [id]);
  await pool.query('DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE merchant_id = $1)', [id]);
  await pool.query('DELETE FROM payments WHERE merchant_id = $1', [id]);
  await pool.query('DELETE FROM merchants WHERE id = $1', [id]);
}

function serviceEnv(databaseUrl: string, listenPort: number, webhookUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CHECKOUT_MODE: 'fake',
    PORT: String(listenPort),
    DATABASE_URL: databaseUrl,
    MERCHANT_API_KEY: merchantKey,
    TREASURY_ACCOUNT_ID: 'treasury.near',
    WEBHOOK_URL: webhookUrl,
  };
  const path = process.env['PATH'];
  if (path !== undefined) env['PATH'] = path;
  return env;
}

async function createPayment(listenPort: number): Promise<PaymentBody> {
  const response = await fetch(`http://127.0.0.1:${listenPort}/payments/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
    body: JSON.stringify({
      merchantOrderId: `PPA-${randomUUID().slice(0, 8)}`,
      amountOut: AMOUNT_OUT,
      originAsset: USDT_TRON_ASSET_ID,
      refundTo: REFUND_TO,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as PaymentBody;
}

async function requestRefund(listenPort: number, paymentId: string): Promise<RefundBody> {
  const response = await fetch(`http://127.0.0.1:${listenPort}/payments/v1/${paymentId}/refunds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': merchantKey },
    body: JSON.stringify({ amount: REFUND_AMOUNT, reason: REFUND_REASON }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as RefundBody;
}

async function waitForStatus(listenPort: number, paymentId: string, status: string): Promise<PaymentBody> {
  const deadline = Date.now() + 25_000;
  let last = '';
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${listenPort}/payments/v1/${paymentId}`, {
      headers: { 'x-api-key': merchantKey },
    });
    try {
      const body = (await response.json()) as PaymentBody;
      if (response.ok && body.status === status) return body;
      last = JSON.stringify(body);
    } catch {
      last = `HTTP ${response.status}`;
    }
    await delay(200);
  }
  throw new Error(`payment did not reach ${status}: ${last}`);
}

async function waitForWebhook(received: string[], logs: () => string): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const match = received.find((body) => body.includes('payment.settled') || body.includes('refund.completed'));
    if (match !== undefined) return match;
    await delay(200);
  }
  throw new Error(`no webhook delivered: ${JSON.stringify(received)}\n${logs()}`);
}

async function waitForReady(listenPort: number, logs: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${listenPort}/health/ready`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await delay(100);
  }
  throw new Error(`service did not become ready: ${last}\n${logs()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startReceiver(): Promise<{ url: string; posts: string[]; close: () => Promise<void> }> {
  const posts: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      posts.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(204).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/hooks`,
        posts,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
