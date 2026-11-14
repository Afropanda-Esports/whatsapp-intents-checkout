import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { decodeQuote } from '../../../src/adaptors/one-click/decode-quote.js';
import { DomainError } from '../../../src/domain/domain-error.js';
import { quoteResponseFixture } from '../../fixtures/quotes.js';

function withRefundFee(refundFee: unknown | 'omit'): Record<string, unknown> {
  const body = quoteResponseFixture();
  const quote = body['quote'] as Record<string, unknown>;
  if (refundFee === 'omit') delete quote['refundFee'];
  else quote['refundFee'] = refundFee;
  return body;
}

function rejected(body: unknown): unknown {
  try {
    decodeQuote(body);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('decodeQuote refund fee', () => {
  it('keeps a digit-string refund fee on the terms', () => {
    expect(decodeQuote(quoteResponseFixture()).terms.refundFee).toBe('2400');
  });

  it.each(['omit', null, '1.5'])('rejects refundFee %s as quote-unavailable', (refundFee) => {
    const error = rejected(withRefundFee(refundFee));
    expect(error).toBeInstanceOf(DomainError);
    expect(error).not.toBeInstanceOf(ZodError);
    expect((error as DomainError).code).toBe('quote-unavailable');
  });
});
