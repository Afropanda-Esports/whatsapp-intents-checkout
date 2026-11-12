import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { DomainError, type DomainErrorCode } from '../../../domain/domain-error.js';
import type { CreatePaymentInput, CreatePaymentResult, Payment } from '../../../domain/payment/types.js';
import { errorFields } from '../../../logging.js';
import { problemDocument } from '../shared/problem.js';
import { paymentHal } from './hal.js';
import { createPaymentBody, zodErrors } from './schema-create.js';

export type PaymentRoutesDeps = {
  authenticate: (apiKey: string | undefined) => void;
  createPayment: (input: CreatePaymentInput) => Promise<CreatePaymentResult>;
  getPayment: (merchantId: string, paymentId: string) => Promise<Payment>;
  merchantId: string | undefined;
  publicBaseUrl: string;
  logger: Logger;
};

const PROBLEMS: Partial<Record<DomainErrorCode, { status: number; title: string }>> = {
  unauthorized: { status: 401, title: 'Unauthorized' },
  'invalid-request': { status: 400, title: 'Invalid request' },
  'not-found': { status: 404, title: 'Not found' },
  'order-conflict': { status: 409, title: 'Order already has a different payment' },
  'unsupported-asset': { status: 422, title: 'Unsupported origin asset' },
  'quote-rejected': { status: 422, title: 'Quote rejected by 1Click' },
  'quote-unavailable': { status: 503, title: 'Quote unavailable' },
  'checkout-disabled': { status: 503, title: 'Checkout disabled' },
};

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentRoutesDeps): void {
  app.post('/payments/v1', async (request, reply) =>
    handle(request, reply, deps, async (merchantId) => {
      const parsed = createPaymentBody.safeParse(request.body);
      if (!parsed.success) throw new DomainError('invalid-request', { errors: zodErrors(parsed.error) });
      const { confidential, ...rest } = parsed.data;
      const result = await deps.createPayment({
        merchantId,
        ...rest,
        ...(confidential === undefined ? {} : { confidential }),
      });
      return reply
        .code(result.created ? 201 : 200)
        .type('application/hal+json')
        .send(paymentHal(result.payment, deps.publicBaseUrl));
    }),
  );

  app.get<{ Params: { paymentId: string } }>('/payments/v1/:paymentId', async (request, reply) =>
    handle(request, reply, deps, async (merchantId) => {
      const payment = await deps.getPayment(merchantId, request.params.paymentId);
      return reply.code(200).type('application/hal+json').send(paymentHal(payment, deps.publicBaseUrl));
    }),
  );
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: PaymentRoutesDeps,
  run: (merchantId: string) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    deps.authenticate(headerValue(request.headers['x-api-key']));
    if (deps.merchantId === undefined) throw new DomainError('unauthorized');
    return await run(deps.merchantId);
  } catch (error) {
    const mapped = error instanceof DomainError ? PROBLEMS[error.code] : undefined;
    if (error instanceof DomainError && mapped !== undefined) {
      if (mapped.status >= 500) deps.logger.warn({ correlationId: request.id, code: error.code }, 'payment request failed');
      const extensions: Record<string, unknown> = { ...error.details };
      if (mapped.status >= 500) extensions['correlationId'] = request.id;
      return reply
        .code(mapped.status)
        .type('application/problem+json')
        .send(problemDocument(deps.publicBaseUrl, mapped.status, `/problems/${error.code}`, mapped.title, extensions));
    }
    deps.logger.error({ correlationId: request.id, err: errorFields(error) }, 'payment request crashed');
    return reply
      .code(500)
      .type('application/problem+json')
      .send(problemDocument(deps.publicBaseUrl, 500, '/problems/internal', 'Internal error', { correlationId: request.id }));
  }
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length === 0 ? undefined : trimmed;
}
