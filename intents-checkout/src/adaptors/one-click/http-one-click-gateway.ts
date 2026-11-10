import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import { decodeTokens } from './decode-tokens.js';
import { DomainError } from '../../domain/domain-error.js';

const REQUEST_TIMEOUT_MS = 5_000;

export type OneClickGatewayOptions = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export function createHttpOneClickGateway(options: OneClickGatewayOptions): IntentsGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async listTokens() {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.apiKey !== undefined && options.apiKey.length > 0) {
        headers['X-API-Key'] = options.apiKey;
      }
      let response: Response;
      try {
        response = await fetchImpl(new URL('/v0/tokens', options.baseUrl), {
          method: 'GET',
          headers,
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
  };
}
