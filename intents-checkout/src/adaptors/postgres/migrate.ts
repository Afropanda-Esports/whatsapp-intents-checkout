import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  await migrate(drizzle(pool), { migrationsFolder });
}
