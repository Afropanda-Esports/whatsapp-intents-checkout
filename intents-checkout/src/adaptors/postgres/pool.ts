import { Pool } from 'pg';

const CONNECTION_TIMEOUT_MS = 2_000;

/**
 * An idle client that loses its connection emits `'error'` on the pool. With no
 * listener, Node treats that as an unhandled error and exits, so the pool always
 * forwards it to `onError`. Errors during a query still reject that query.
 */
export function createPool(databaseUrl: string, onError: (error: Error) => void): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    max: 5,
  });
  pool.on('error', onError);
  return pool;
}
