import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import type { QuoteRequest } from '../../domain/payment/types.js';
import { decodeTokens } from './decode-tokens.js';
import { decodeQuote } from './decode-quote.js';
import { DomainError } from '../../domain/domain-error.js';

const REQUEST_TIMEOUT_MS = 5_000;
/** The quote call waits up to quoteWaitingTimeMs for solvers, so allow that plus network time. */
const QUOTE_TIMEOUT_MS = 8_000;

export type OneClickGatewayOptions = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export function createHttpOneClickGateway(options: OneClickGatewayOptions): IntentsGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const all: Record<string, string> = { accept: 'application/json', ...extra };
    if (options.apiKey !== undefined && options.apiKey.length > 0) all['X-API-Key'] = options.apiKey;
    return all;
  };

  return {
    async listTokens() {
      let response: Response;
      try {
        response = await fetchImpl(new URL('/v0/tokens', options.baseUrl), {
          method: 'GET',
          headers: headers(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new DomainError('tokens-unavailable');
      }
      if (!response.ok) throw new DomainError('tokens-unavailable');
      try {
        return decodeTokens(await response.json());
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('tokens-unavailable');
      }
    },

    async requestQuote(request) {
      let response: Response;
      try {
        response = await fetchImpl(new URL('/v0/quote', options.baseUrl), {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(quoteBody(request)),
          signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
        });
      } catch {
        throw new DomainError('quote-unavailable');
      }
      // 401/403 mean our partner key is wrong, not that the customer's request is: unavailable.
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) {
        throw new DomainError('quote-rejected', { reason: await vendorMessage(response) });
      }
      if (!response.ok) throw new DomainError('quote-unavailable');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new DomainError('quote-unavailable');
      }
      return decodeQuote(payload);
    },
  };
}

function quoteBody(request: QuoteRequest): Record<string, unknown> {
  return {
    dry: false,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: request.slippageBps,
    originAsset: request.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: request.destinationAsset,
    amount: request.amountOut,
    refundTo: request.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: request.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: request.deadline,
    quoteWaitingTimeMs: request.quoteWaitingTimeMs,
  };
}

async function vendorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0) return body.message.slice(0, 300);
  } catch {
    // fall through
  }
  return `1Click rejected the quote (HTTP ${response.status})`;
}
