import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DestinationStream } from 'pino';
import { Pool } from 'pg';
import { buildServer } from '../src/adaptors/fastify/server.js';
import { runMigrations } from '../src/adaptors/postgres/migrate.js';
import { ping } from '../src/adaptors/postgres/ping.js';
import { createPool } from '../src/adaptors/postgres/pool.js';
import { createHealthChecker } from '../src/health/health-service.js';
import { createLogger } from '../src/logging.js';

const tables = ['merchants', 'payments', 'payment_events', 'disbursements', 'outbox_events'];
const closedDatabaseUrl = 'postgres://postgres:postgres@127.0.0.1:1/intents_checkout';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const namedIndexes = [
  'payments_status_idx',
  'payment_events_payment_id_idx',
  'disbursements_payment_id_idx',
  'outbox_events_pending_idx',
];

function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

async function insertMerchant(pool: Pool, apiKeyHash: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (name, api_key_hash, webhook_url, webhook_secret)
     VALUES ('CHK-001 test merchant', $1, 'https://example.invalid/webhook', 'secret')
     RETURNING id`,
    [apiKeyHash],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('merchant insert returned no id');
  return id;
}

function captureLogs(): { stream: DestinationStream; lines: () => Array<Record<string, unknown>> } {
  const parsed: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.length > 0) parsed.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream: stream as DestinationStream, lines: () => parsed };
}

describe('CHK-001 health probes', () => {
  const pools: Pool[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('migrates, reports live and ready, and echoes the request id', async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required');
    }
    const pool = createPool(databaseUrl, () => {});
    pools.push(pool);
    await runMigrations(pool);
    await runMigrations(pool);

    const found = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables],
    );
    expect(found.rows.map((row) => row.table_name).sort()).toEqual([...tables].sort());

    const logs = captureLogs();
    const health = createHealthChecker(() => ping(pool));
    const app = await buildServer({
      checkLive: () => health.live(),
      checkReady: () => health.ready(),
      logger: createLogger(logs.stream),
    });
    const requestId = 'chk-001-request';
    const live = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': requestId },
    });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'live' });
    expect(live.headers['x-request-id']).toBe(requestId);

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', postgres: 'up' },
    });

    const logged = logs.lines().find((line) => line['correlationId'] === requestId);
    expect(logged).toMatchObject({ correlationId: requestId });
    await app.close();
  });

  it('reports not-ready when postgres is closed and live stays up', async () => {
    const pool = createPool(closedDatabaseUrl, () => {});
    pools.push(pool);
    const logs = captureLogs();
    const health = createHealthChecker(() => ping(pool));
    const app = await buildServer({
      checkLive: () => health.live(),
      checkReady: () => health.ready(),
      logger: createLogger(logs.stream),
    });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'live' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'not-ready',
      checks: { config: 'ok', postgres: 'down' },
    });
    const failure = logs.lines().find((line) => line['msg'] === 'postgres ping failed');
    expect(failure).toMatchObject({ msg: 'postgres ping failed' });
    expect(JSON.stringify(failure)).not.toContain('postgres://');
    await app.close();
  });

  it('truncates an oversized x-request-id', async () => {
    const logs = captureLogs();
    const health = createHealthChecker(async () => true);
    const app = await buildServer({
      checkLive: () => health.live(),
      checkReady: () => health.ready(),
      logger: createLogger(logs.stream),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'a'.repeat(200) },
    });
    expect(response.headers['x-request-id']).toBe('a'.repeat(128));
    expect(logs.lines().some((line) => line['correlationId'] === 'a'.repeat(128))).toBe(true);
    await app.close();
  });

  it('CHK-001 survives postgres terminating an idle connection and recovers', async () => {
    const databaseUrl = requireDatabaseUrl();
    const onError = vi.fn();
    const pool = createPool(databaseUrl, onError);
    const admin = createPool(databaseUrl, () => {});
    pools.push(pool, admin);
    await runMigrations(pool);

    const health = createHealthChecker(() => ping(pool));
    const app = await buildServer({
      checkLive: () => health.live(),
      checkReady: () => health.ready(),
      logger: createLogger(captureLogs().stream),
    });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onError).toHaveBeenCalled();
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    await app.close();
  });

  it('CHK-001 startup failure exits 1 with a diagnosable, secret-free log line', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: projectRoot,
      env: {
        PATH: process.env['PATH'],
        PORT: '3997',
        DATABASE_URL: 'postgres://postgres:s3cret@127.0.0.1:1/intents_checkout',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain('postgres://');
    expect(output).not.toContain('s3cret');
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = lines.find((line) => line['msg'] === 'migration failed');
    expect(failure).toMatchObject({ msg: 'migration failed', err: { code: 'ECONNREFUSED' } });
  });

  it('CHK-001 schema rejects unknown statuses and duplicate key hashes and has the named indexes', async () => {
    const pool = createPool(requireDatabaseUrl(), () => {});
    pools.push(pool);
    await runMigrations(pool);

    const apiKeyHash = `chk-001-${randomUUID()}`;
    const merchantId = await insertMerchant(pool, apiKeyHash);
    try {
      const duplicate = await insertMerchant(pool, apiKeyHash).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(sqlState(duplicate)).toBe('23505');

      const bogus = await pool
        .query(
          `INSERT INTO payments (merchant_id, merchant_order_id, status, origin_asset, destination_asset,
             amount_out, amount_in, min_amount_in, deposit_address, refund_to, deadline)
           VALUES ($1, $2, 'BOGUS', 'nep141:origin', 'nep141:usdc', 1, 1, 1, $3, 'refund-to', now())`,
          [merchantId, randomUUID(), randomUUID()],
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(sqlState(bogus)).toBe('23514');

      const indexes = await pool.query<{ indexname: string }>(
        'SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])',
        [namedIndexes],
      );
      expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([...namedIndexes].sort());
    } finally {
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM merchants WHERE api_key_hash = $1', [apiKeyHash]);
    }
  });
});
