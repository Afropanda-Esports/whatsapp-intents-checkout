import { Pool } from 'pg';

const CONNECTION_TIMEOUT_MS = 2_000;

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    max: 5,
  });
}
