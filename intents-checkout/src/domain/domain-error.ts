export type DomainErrorCode =
  | 'unauthorized'
  | 'tokens-unavailable'
  | 'invalid-request'
  | 'unsupported-asset'
  | 'order-conflict'
  | 'quote-unavailable'
  | 'quote-rejected'
  | 'not-found'
  | 'checkout-disabled';

/** Extra fields for the problem document, e.g. `paymentId`, `originAsset`, `errors`. */
export type DomainErrorDetails = Record<string, unknown>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, details: DomainErrorDetails = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
