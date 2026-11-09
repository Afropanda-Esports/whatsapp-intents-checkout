import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../../src/adaptors/postgres/pool.js';

describe('createPool', () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it('registers an error listener so an idle client error cannot crash the process', () => {
    pool = createPool('postgres://localhost:1/db', vi.fn());
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });

  it('forwards a pool error to onError instead of throwing', () => {
    const onError = vi.fn();
    pool = createPool('postgres://localhost:1/db', onError);
    const err = new Error('terminating connection due to administrator command');
    expect(() => pool?.emit('error', err)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(err);
  });
});
