import { z } from 'zod';
import { ONE_CLICK_STATUSES, type StatusSnapshot } from '../../domain/payment/types.js';

const baseUnits = z.string().regex(/^[0-9]+$/u).nullish();
const chainTx = z.object({ hash: z.string().min(1), explorerUrl: z.string() });

const responseSchema = z
  .object({
    status: z.enum(ONE_CLICK_STATUSES),
    swapDetails: z
      .object({
        depositedAmount: baseUnits.optional(),
        amountOut: baseUnits.optional(),
        originChainTxHashes: z.array(chainTx),
        destinationChainTxHashes: z.array(chainTx),
      })
      .passthrough(),
  })
  .passthrough();

/** Undefined when the body is not a status we can apply. Does not throw. */
export function decodeStatus(payload: unknown): StatusSnapshot | undefined {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const details = parsed.data.swapDetails;
  return {
    oneClickStatus: parsed.data.status,
    depositedAmount: details.depositedAmount ?? null,
    amountOut: details.amountOut ?? null,
    originTxHashes: details.originChainTxHashes,
    destinationTxHashes: details.destinationChainTxHashes,
  };
}
