import { z } from 'zod';
import { DomainError } from '../../domain/domain-error.js';
import type { SignedQuote } from '../../domain/payment/types.js';

export { quoteRequestRecipient } from '../../domain/disbursement/quote-recipient.js';

const baseUnits = z.string().regex(/^[0-9]+$/u);

const responseSchema = z
  .object({
    quote: z
      .object({
        depositAddress: z.string().min(1),
        depositMemo: z.string().min(1).optional(),
        amountIn: baseUnits,
        minAmountIn: baseUnits,
        refundFee: baseUnits,
        amountOut: baseUnits,
        deadline: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Translate a 1Click quote response into terms; keep the whole response verbatim as `raw`. */
export function decodeQuote(payload: unknown): SignedQuote {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new DomainError('quote-unavailable');
  const quote = parsed.data.quote;
  return {
    terms: {
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo ?? null,
      amountIn: quote.amountIn,
      minAmountIn: quote.minAmountIn,
      refundFee: quote.refundFee,
      amountOut: quote.amountOut,
      deadline: quote.deadline ?? null,
    },
    raw: payload,
  };
}
