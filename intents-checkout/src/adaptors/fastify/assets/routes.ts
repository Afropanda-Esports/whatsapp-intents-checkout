import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { OriginAsset } from '../../../domain/asset/origin-asset.js';
import { DomainError } from '../../../domain/domain-error.js';
import { errorFields } from '../../../logging.js';
import { assetsHal } from './hal.js';
import { problemDocument } from '../shared/problem.js';

export type AssetRoutesDeps = {
  authenticate: (apiKey: string | undefined) => void;
  listAssets: () => Promise<OriginAsset[]>;
  publicBaseUrl: string;
  logger: Logger;
};

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRoutesDeps): void {
  app.get('/assets/v1', async (request, reply) => {
    try {
      deps.authenticate(headerValue(request.headers['x-api-key']));
      const assets = await deps.listAssets();
      return reply
        .code(200)
        .type('application/hal+json')
        .send(assetsHal(assets, deps.publicBaseUrl));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'unauthorized') {
        return reply
          .code(401)
          .type('application/problem+json')
          .send(problemDocument(deps.publicBaseUrl, 401, '/problems/unauthorized', 'Unauthorized'));
      }
      if (!(error instanceof DomainError)) {
        deps.logger.warn({ correlationId: request.id, err: errorFields(error) }, 'token list failed');
      } else {
        deps.logger.warn({ correlationId: request.id }, 'token list failed');
      }
      return reply
        .code(503)
        .type('application/problem+json')
        .send(
          problemDocument(deps.publicBaseUrl, 503, '/problems/tokens-unavailable', 'Token list unavailable', {
            correlationId: request.id,
          }),
        );
    }
  });
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length === 0 ? undefined : trimmed;
}
