import { z } from 'zod';

/** Shape only. Amount rules and the confidential decision live in the domain. */
export const createPaymentBody = z
  .object({
    merchantOrderId: z.string().min(1).max(64),
    amountOut: z.string().min(1).max(78),
    originAsset: z.string().min(1).max(256),
    refundTo: z.string().min(1).max(128),
    confidential: z.boolean().optional(),
  })
  .strict();

export type CreatePaymentBody = z.infer<typeof createPaymentBody>;

export const createRefundBody = z
  .object({
    amount: z.string().min(1).max(78),
    reason: z.string().min(1).max(200),
  })
  .strict();

export function zodErrors(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.') || 'body', message: issue.message }));
}
