import { createHttpOneClickGateway } from './adaptors/one-click/http-one-click-gateway.js';
import { createPool } from './adaptors/postgres/pool.js';
import { ping } from './adaptors/postgres/ping.js';
import { runMigrations } from './adaptors/postgres/migrate.js';
import { buildServer } from './adaptors/fastify/server.js';
import { loadConfig, type AppConfig } from './config.js';
import { createAssetService } from './domain/asset/asset-service.js';
import { DomainError } from './domain/domain-error.js';
import { createMerchantAuth } from './domain/merchant/merchant-auth-service.js';
import { createHealthChecker } from './health/health-service.js';
import { createLogger, errorFields } from './logging.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger();
  const pool = createPool(config.databaseUrl, (error) => {
    logger.warn({ msg: 'postgres client error', err: errorFields(error) });
  });
  try {
    await runMigrations(pool);
  } catch (error) {
    logger.error({ msg: 'migration failed', err: errorFields(error) });
    await pool.end();
    process.exit(1);
  }

  const health = createHealthChecker(() => ping(pool));
  const assets = createAssetCatalog(config);
  const auth = createMerchantAuth(config.merchantApiKey ?? '');
  const app = await buildServer({
    checkLive: () => health.live(),
    checkReady: () => health.ready(),
    logger,
    assets: {
      authenticate: (apiKey) => auth.authenticate(apiKey),
      listAssets: () => assets.listAssets(),
      publicBaseUrl: config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`,
    },
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ msg: 'listening', port: config.port });
  } catch (error) {
    logger.error({ msg: 'server failed to listen', err: errorFields(error) });
    await app.close();
    await pool.end();
    process.exit(1);
  }
}

function createAssetCatalog(config: AppConfig) {
  const tokens =
    config.oneClickBaseUrl === undefined
      ? {
          async listTokens() {
            throw new DomainError('tokens-unavailable');
          },
        }
      : createHttpOneClickGateway({
          baseUrl: config.oneClickBaseUrl,
          ...(config.oneClickApiKey === undefined ? {} : { apiKey: config.oneClickApiKey }),
        });
  return createAssetService({ tokens, clock: () => Date.now() });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'startup failed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
