import { randomBytes, randomUUID } from 'node:crypto';
import { KeyPairEd25519 } from 'near-api-js';
import { startFakeNearRpc } from './adaptors/fake/fake-near-rpc.js';
import { startFakeOneClick } from './adaptors/fake/fake-one-click-http.js';
import { createHttpWebhookSender } from './adaptors/http-webhook/http-webhook-sender.js';
import { createRpcPolicyLedger } from './adaptors/near-rpc/rpc-policy-ledger.js';
import { createHttpOneClickGateway } from './adaptors/one-click/http-one-click-gateway.js';
import { createPool } from './adaptors/postgres/pool.js';
import { createPostgresMerchantDirectory } from './adaptors/postgres/postgres-merchant-directory.js';
import { createPostgresOutboxStore } from './adaptors/postgres/postgres-outbox-store.js';
import { createPostgresDisbursementRepository } from './adaptors/postgres/postgres-disbursement-repository.js';
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
import { createRefundService } from './domain/disbursement/refund-service.js';
import { createPaymentFulfilmentService } from './domain/payment/payment-fulfilment-service.js';
import { createPaymentReadService } from './domain/payment/payment-read-service.js';
import { createTrackPayments } from './domain/payment/track-payments.js';
import { createRelayWebhooks } from './domain/notification/relay-webhooks.js';
import { PAYMENT_POLL_INTERVAL_MS, startPaymentPoller } from './jobs/track-payments.js';
import { WEBHOOK_RELAY_INTERVAL_MS, startWebhookRelay } from './jobs/relay-webhooks.js';
import {
  DEFAULT_DESTINATION_ASSET_ID,
  DEFAULT_PAYMENT_WINDOW_MINUTES,
  DEFAULT_QUOTE_SLIPPAGE_BPS,
} from './domain/payment/payment-service-deps.js';
import type { IntentsGateway } from './ports/outbound/intents-gateway.js';
import { createHealthChecker } from './health/health-service.js';
import { createLogger, errorFields } from './logging.js';

type StandIns = {
  oneClickUrl: string;
  nearUrl: string;
  close(): Promise<void>;
};

async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  const logger = createLogger();
  logFakeMerchantKey(logger, loaded);
  const standIns = loaded.checkoutMode === 'fake' ? await startStandIns() : undefined;
  const config = standIns === undefined ? loaded : pointAtStandIns(loaded, standIns);
  const pool = createPool(config.databaseUrl, (error) => {
    logger.warn({ msg: 'postgres client error', err: errorFields(error) });
  });
  try {
    await runMigrations(pool);
  } catch (error) {
    logger.error({ msg: 'migration failed', err: errorFields(error) });
    await pool.end();
    await standIns?.close();
    process.exit(1);
  }

  const health = createHealthChecker(() => ping(pool));
  const gateway = createGateway(config);
  const assets = createAssetService({ tokens: gateway, clock: () => Date.now() });
  const auth = createMerchantAuth(config.merchantApiKey ?? '');
  const directory = createPostgresMerchantDirectory(pool);
  const merchantId = await registerDefaultMerchant(directory, config.merchantApiKey, () => randomBytes(32).toString('hex'));
  if (merchantId !== undefined && config.webhookUrl !== undefined) {
    await directory.setWebhookUrl(merchantId, config.webhookUrl);
  }
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
      checkoutEnabled: config.checkoutEnabled,
    },
  });
  const readPayments = createPaymentReadService({ payments });
  const ledger = config.policy === undefined ? undefined : createRpcPolicyLedger(config.policy);
  const publicBaseUrl = config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;
  const fulfilPayments = createPaymentFulfilmentService({
    getPayment: (merchant, paymentId) => readPayments.getPayment(merchant, paymentId),
    markFulfilled: (merchant, paymentId) => payments.markFulfilled(merchant, paymentId),
    ...(ledger === undefined ? {} : { ledger }),
  });
  const refunds = createRefundService({
    getPayment: (merchant, paymentId) => readPayments.getPayment(merchant, paymentId),
    disbursements: createPostgresDisbursementRepository(pool),
    quotes: gateway,
    clock: () => new Date(),
    newId: () => randomUUID(),
    publicBaseUrl,
    settings: {
      ...(config.treasuryAccountId === undefined ? {} : { treasuryAccountId: config.treasuryAccountId }),
      slippageBps: config.quoteSlippageBps ?? DEFAULT_QUOTE_SLIPPAGE_BPS,
      paymentWindowMinutes: config.paymentWindowMinutes ?? DEFAULT_PAYMENT_WINDOW_MINUTES,
    },
    ...(ledger === undefined ? {} : { ledger }),
  });
  const paymentTickMs = config.checkoutMode === 'fake' ? 500 : PAYMENT_POLL_INTERVAL_MS;
  const webhookTickMs = config.checkoutMode === 'fake' ? 500 : WEBHOOK_RELAY_INTERVAL_MS;
  startPaymentPoller(
    createTrackPayments({
      payments,
      statuses: gateway,
      merchants: directory,
      publicBaseUrl,
      newEventId: () => randomUUID(),
      clock: () => new Date(),
      ...(ledger === undefined ? {} : { ledger }),
      onSkip: ({ paymentId, correlationId, code, reason }) => {
        logger.warn(
          {
            paymentId,
            correlationId,
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
          },
          'status poll skipped',
        );
      },
    }),
    {
      info: (fields, message) => logger.info(fields, message),
      error: (fields, message) => logger.error(fields, message),
    },
    paymentTickMs,
  );
  startWebhookRelay(
    createRelayWebhooks({
      outbox: createPostgresOutboxStore(pool),
      merchants: directory,
      sender: createHttpWebhookSender(),
      onFifthFailure: ({ eventId }) => {
        logger.error({ eventId }, 'webhook delivery failed five times');
      },
      onError: ({ eventId, message }) => {
        logger.error({ eventId, message }, 'webhook relay failed');
      },
    }),
    {
      info: (fields, message) => logger.info(fields, message),
      error: (fields, message) => logger.error(fields, message),
    },
    webhookTickMs,
  );
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
      fulfilPayment: (merchant, paymentId) => fulfilPayments.fulfil(merchant, paymentId),
      requestRefund: (merchant, paymentId, input) => refunds.request(merchant, paymentId, input),
      listRefunds: (merchant, paymentId) => refunds.list(merchant, paymentId),
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
    await standIns?.close();
    await pool.end();
    process.exit(1);
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void app
      .close()
      .catch(() => undefined)
      .then(() => standIns?.close())
      .catch(() => undefined)
      .then(() => pool.end())
      .catch(() => undefined)
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Fake mode prints the configured merchant key so a judge can call the API. Live mode does not. */
function logFakeMerchantKey(logger: ReturnType<typeof createLogger>, config: AppConfig): void {
  if (config.checkoutMode !== 'fake' || config.merchantApiKey === undefined) return;
  logger.info(`merchant api key ${config.merchantApiKey}`);
}

/** Local 1Click and NEAR stand-ins. Nothing here dials mainnet. */
async function startStandIns(): Promise<StandIns> {
  const oneClick = await startFakeOneClick({ settleQuotedDeposits: true });
  const near = await startFakeNearRpc();
  return {
    oneClickUrl: oneClick.url,
    nearUrl: near.url,
    async close() {
      await oneClick.close();
      await near.close();
    },
  };
}

/**
 * Points the HTTP 1Click gateway and the NEAR RPC ledger at the stand-ins.
 * A configured mainnet URL is replaced. Missing operator settings are filled in
 * so settlement can register_payment and a refund can quote, check the recipient, and execute_refund.
 */
function pointAtStandIns(config: AppConfig, standIns: StandIns): AppConfig {
  const secret = KeyPairEd25519.fromRandom().secretKey;
  return {
    ...config,
    oneClickBaseUrl: standIns.oneClickUrl,
    policy: {
      rpcUrl: standIns.nearUrl,
      contractId: config.policy?.contractId ?? 'policy.fake.near',
      operatorAccountId: config.policy?.operatorAccountId ?? 'operator.fake.near',
      operatorPrivateKey: config.policy?.operatorPrivateKey ?? `ed25519:${secret}`,
    },
  };
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
