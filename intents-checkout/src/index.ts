import { randomBytes } from 'node:crypto';
import { createHttpOneClickGateway } from './adaptors/one-click/http-one-click-gateway.js';
import { createPool } from './adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from './adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresPaymentRepository } from './adaptors/postgres/postgres-payment-repository.js';
import { ping } from './adaptors/postgres/ping.js';
import { runMigrations } from './adaptors/postgres/migrate.js';
import { buildServer } from './adaptors/fastify/server.js';
import { loadConfig, type AppConfig } from './config.js';
import { createAssetService } from './domain/asset/asset-service.js';
import { DomainError } from './domain/domain-error.js';
import { registerDefaultMerchant } from './domain/merchant/default-merchant.js';
import { createMerchantAuth } from './domain/merchant/merchant-auth-service.js';
import { createPaymentCreationService } from './domain/payment/payment-creation-service.js';
import { createPaymentReadService } from './domain/payment/payment-read-service.js';
import { createTrackPayments } from './domain/payment/track-payments.js';
import { startPaymentPoller } from './jobs/track-payments.js';
import {
  DEFAULT_DESTINATION_ASSET_ID,
  DEFAULT_PAYMENT_WINDOW_MINUTES,
  DEFAULT_QUOTE_SLIPPAGE_BPS,
} from './domain/payment/payment-service-deps.js';
import type { IntentsGateway } from './ports/outbound/intents-gateway.js';
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
  const gateway = createGateway(config);
  const assets = createAssetService({ tokens: gateway, clock: () => Date.now() });
  const auth = createMerchantAuth(config.merchantApiKey ?? '');
  const merchantId = await registerDefaultMerchant(createPostgresMerchantDirectory(pool), config.merchantApiKey, () =>
    randomBytes(32).toString('hex'),
  );
  const payments = createPostgresPaymentRepository(pool);
  const createPayments = createPaymentCreationService({
    quotes: gateway,
    assets,
    payments,
    clock: () => new Date(),
    settings: {
      ...(config.treasuryAccountId === undefined ? {} : { treasuryAccountId: config.treasuryAccountId }),
      destinationAssetId: config.destinationAssetId ?? DEFAULT_DESTINATION_ASSET_ID,
      paymentWindowMinutes: config.paymentWindowMinutes ?? DEFAULT_PAYMENT_WINDOW_MINUTES,
      slippageBps: config.quoteSlippageBps ?? DEFAULT_QUOTE_SLIPPAGE_BPS,
    },
  });
  const readPayments = createPaymentReadService({ payments });
  startPaymentPoller(
    createTrackPayments({
      payments,
      statuses: gateway,
      clock: () => new Date(),
      onSkip: ({ paymentId, correlationId }) => {
        logger.warn({ paymentId, correlationId }, 'status poll skipped');
      },
    }),
    {
      info: (fields, message) => logger.info(fields, message),
      error: (fields, message) => logger.error(fields, message),
    },
  );
  const publicBaseUrl = config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;
  if (config.treasuryAccountId === undefined) {
    logger.warn({ msg: 'TREASURY_ACCOUNT_ID not set: POST /payments/v1 returns 503 quote-unavailable' });
  }
  const app = await buildServer({
    checkLive: () => health.live(),
    checkReady: () => health.ready(),
    logger,
    assets: {
      authenticate: (apiKey) => auth.authenticate(apiKey),
      listAssets: () => assets.listAssets(),
      publicBaseUrl,
    },
    payments: {
      authenticate: (apiKey) => auth.authenticate(apiKey),
      createPayment: (input) => createPayments.createPayment(input),
      getPayment: (merchant, paymentId) => readPayments.getPayment(merchant, paymentId),
      merchantId,
      publicBaseUrl,
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

/** Without ONE_CLICK_BASE_URL the service still boots; catalog and quotes report unavailable. */
function createGateway(config: AppConfig): IntentsGateway {
  if (config.oneClickBaseUrl === undefined) {
    return {
      async listTokens() {
        throw new DomainError('tokens-unavailable');
      },
      async requestQuote() {
        throw new DomainError('quote-unavailable');
      },
      async getStatus() {
        return undefined;
      },
    };
  }
  return createHttpOneClickGateway({
    baseUrl: config.oneClickBaseUrl,
    ...(config.oneClickApiKey === undefined ? {} : { apiKey: config.oneClickApiKey }),
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'startup failed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
