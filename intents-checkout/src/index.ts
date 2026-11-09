import { createPool } from './adaptors/postgres/pool.js';
import { ping } from './adaptors/postgres/ping.js';
import { runMigrations } from './adaptors/postgres/migrate.js';
import { buildServer } from './adaptors/fastify/server.js';
import { loadConfig } from './config.js';
import { createHealthChecker } from './health/health-service.js';
import { createLogger } from './logging.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger();
  const pool = createPool(config.databaseUrl);
  try {
    await runMigrations(pool);
  } catch {
    logger.error({ msg: 'migration failed' });
    await pool.end();
    process.exit(1);
  }

  const health = createHealthChecker(() => ping(pool));
  const app = await buildServer({
    checkLive: () => health.live(),
    checkReady: () => health.ready(),
    logger,
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ msg: 'listening', port: config.port });
  } catch {
    logger.error({ msg: 'server failed to listen' });
    await app.close();
    await pool.end();
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'startup failed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
