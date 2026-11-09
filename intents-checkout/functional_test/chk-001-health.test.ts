import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
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
    const pool = createPool(databaseUrl);
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
    const pool = createPool(closedDatabaseUrl);
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
});
