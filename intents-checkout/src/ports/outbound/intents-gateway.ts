import type { OriginAsset } from '../../domain/asset/origin-asset.js';
import type { QuoteRequest, SignedQuote } from '../../domain/payment/types.js';

export type IntentsGateway = {
  listTokens(): Promise<OriginAsset[]>;
  /** Non-dry EXACT_OUTPUT quote. Throws DomainError quote-unavailable / quote-rejected / unsupported-asset. */
  requestQuote(request: QuoteRequest): Promise<SignedQuote>;
};
