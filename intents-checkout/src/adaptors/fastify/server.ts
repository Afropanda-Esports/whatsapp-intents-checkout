import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { DomainError } from '../../domain/domain-error.js';
import { notReadyReport, type HealthReport } from '../../health/health-service.js';
import type { OriginAsset } from '../../domain/asset/origin-asset.js';
import type { RefundResource } from '../../domain/disbursement/refund-resource.js';
import type { CreatePaymentInput, CreatePaymentResult, Payment } from '../../domain/payment/types.js';
import { registerAssetRoutes } from './assets/routes.js';
import { registerPaymentRoutes } from './payments/routes.js';
import { problemDocument } from './shared/problem.js';

const REQUEST_ID_LIMIT = 128;

export type ServerDeps = {
  checkLive: () => HealthReport;
  checkReady: () => Promise<HealthReport>;
  logger: Logger;
  assets?: {
    authenticate: (apiKey: string | undefined) => void;
    listAssets: () => Promise<OriginAsset[]>;
    publicBaseUrl: string;
  };
  payments?: {
    authenticate: (apiKey: string | undefined) => void;
    createPayment: (input: CreatePaymentInput) => Promise<CreatePaymentResult>;
    getPayment: (merchantId: string, paymentId: string) => Promise<Payment>;
    fulfilPayment?: (merchantId: string, paymentId: string) => Promise<Payment>;
    requestRefund?: (
      merchantId: string,
      paymentId: string,
      input: { amount: string; reason: string },
    ) => Promise<RefundResource>;
    listRefunds?: (merchantId: string, paymentId: string) => Promise<RefundResource[]>;
    /** The default merchant's id; undefined when no merchant key is configured. */
    merchantId: string | undefined;
    publicBaseUrl: string;
  };
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const id = normalizeRequestId(request.headers['x-request-id']);
    request.id = id;
    void reply.header('x-request-id', id);
  });

  app.addHook('onResponse', async (request) => {
    deps.logger.info({ correlationId: request.id }, 'request');
  });

  // Body-parse failures (malformed JSON, wrong content type) become problem documents, not Fastify's default shape.
  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const baseUrl = deps.payments?.publicBaseUrl ?? deps.assets?.publicBaseUrl ?? '';
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? 400 : 500;
    if (status === 500) deps.logger.error({ correlationId: request.id }, 'unhandled request error');
    return reply
      .code(status)
      .type('application/problem+json')
      .send(
        status === 400
          ? problemDocument(baseUrl, 400, '/problems/invalid-request', 'Invalid request', {
              errors: [{ path: 'body', message: 'body must be valid JSON' }],
            })
          : problemDocument(baseUrl, 500, '/problems/internal', 'Internal error', { correlationId: request.id }),
      );
  });

  if (deps.assets !== undefined) {
    registerAssetRoutes(app, { ...deps.assets, logger: deps.logger });
  }

  if (deps.payments !== undefined) {
    registerPaymentRoutes(app, {
      ...deps.payments,
      fulfilPayment:
        deps.payments.fulfilPayment ??
        (async () => {
          throw new DomainError('policy-unavailable');
        }),
      requestRefund:
        deps.payments.requestRefund ??
        (async () => {
          throw new DomainError('policy-unavailable');
        }),
      listRefunds:
        deps.payments.listRefunds ??
        (async () => {
          throw new DomainError('not-found');
        }),
      logger: deps.logger,
    });
  }

  app.get('/health/live', async (_request, reply) => {
    return reply.code(200).send(deps.checkLive());
  });

  app.get('/health/ready', async (request, reply) => {
    try {
      const report = await deps.checkReady();
      if (report.status !== 'ready') logPingFailure(deps.logger, request.id);
      const code = report.status === 'ready' ? 200 : 503;
      return reply.code(code).send(report);
    } catch {
      logPingFailure(deps.logger, request.id);
      return reply.code(503).send(notReadyReport);
    }
  });

  return app;
}

function logPingFailure(logger: Logger, correlationId: string): void {
  logger.warn({ correlationId }, 'postgres ping failed');
}

function normalizeRequestId(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return randomUUID();
  return trimmed.slice(0, REQUEST_ID_LIMIT);
}
