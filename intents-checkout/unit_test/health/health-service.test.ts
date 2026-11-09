import { describe, expect, it, vi } from 'vitest';
import { createHealthChecker } from '../../src/health/health-service.js';

describe('health service', () => {
  it('live does not call ping', () => {
    const ping = vi.fn(async () => true);
    const health = createHealthChecker(ping);
    expect(health.live()).toEqual({ status: 'live' });
    expect(ping).not.toHaveBeenCalled();
  });

  it('ready is ready when ping succeeds', async () => {
    const health = createHealthChecker(async () => true);
    await expect(health.ready()).resolves.toEqual({
      status: 'ready',
      checks: { config: 'ok', postgres: 'up' },
    });
  });

  it('ready is not-ready when ping returns false', async () => {
    const health = createHealthChecker(async () => false);
    await expect(health.ready()).resolves.toEqual({
      status: 'not-ready',
      checks: { config: 'ok', postgres: 'down' },
    });
  });

  it('ready is not-ready when ping throws, and the error text is dropped', async () => {
    const health = createHealthChecker(async () => {
      throw new Error('connect ECONNREFUSED postgres://user:secret@localhost/db');
    });
    const report = await health.ready();
    expect(report).toEqual({
      status: 'not-ready',
      checks: { config: 'ok', postgres: 'down' },
    });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('postgres://');
  });
});
