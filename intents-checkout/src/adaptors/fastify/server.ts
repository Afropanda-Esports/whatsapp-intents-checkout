import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { notReadyReport, type HealthReport } from '../../health/health-service.js';
import type { OriginAsset } from '../../domain/asset/origin-asset.js';
import { registerAssetRoutes } from './assets/routes.js';

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

  if (deps.assets !== undefined) {
    registerAssetRoutes(app, { ...deps.assets, logger: deps.logger });
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
