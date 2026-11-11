import type { OriginAsset } from '../../domain/asset/origin-asset.js';
import type { QuoteRequest, SignedQuote, StatusSnapshot } from '../../domain/payment/types.js';

export type StatusQuery = {
  depositAddress: string;
  depositMemo: string | null;
};

export type IntentsGateway = {
  listTokens(): Promise<OriginAsset[]>;
  /** Non-dry EXACT_OUTPUT quote. Throws DomainError quote-unavailable / quote-rejected / unsupported-asset. */
  requestQuote(request: QuoteRequest): Promise<SignedQuote>;
  /** Undefined when 1Click cannot be read. Never throws. */
  getStatus(query: StatusQuery): Promise<StatusSnapshot | undefined>;
};
