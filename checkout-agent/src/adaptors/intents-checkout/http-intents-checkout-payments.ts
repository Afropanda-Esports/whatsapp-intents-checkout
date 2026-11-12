import { z } from 'zod';
import { isBaseUnits } from '../../domain/conversation/base-units.js';
import type { CheckoutPayment } from '../../domain/conversation/types.js';
import type { CheckoutPayments } from '../../ports/outbound/checkout-payments.js';

/** Fixed by the adaptor. The model never supplies a destination, payee, or account. */
const ORIGIN_ASSET = 'usdt-tron';
const MERCHANT_REFUND_TO = 'merchant-origin-record';

const paymentBody = z.object({
  paymentId: z.string(),
  merchantOrderId: z.string(),
  status: z.string(),
  amountOut: z.string().refine(isBaseUnits),
  depositAddress: z.string(),
});

export type HttpCheckoutOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export function createHttpIntentsCheckoutPayments(options: HttpCheckoutOptions): CheckoutPayments {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async createPayment(input) {
      if (!isBaseUnits(input.amount)) throw new Error('amount must be base units');
      const payload = await checkoutRequest(options, fetchImpl, '/payments/v1', 'POST', {
        merchantOrderId: input.orderId,
        amountOut: input.amount,
        originAsset: ORIGIN_ASSET,
        refundTo: MERCHANT_REFUND_TO,
      });
      return decodePayment(payload, input.orderId);
    },
    async readPayment(paymentId) {
      const payload = await checkoutRequest(
        options,
        fetchImpl,
        `/payments/v1/${encodeURIComponent(paymentId)}`,
        'GET',
      );
      return decodePayment(payload);
    },
    async markFulfilled(paymentId) {
      const payload = await checkoutRequest(
        options,
        fetchImpl,
        `/payments/v1/${encodeURIComponent(paymentId)}/fulfilment`,
        'POST',
      );
      if (payload === undefined) throw new Error('checkout-unavailable');
    },
  };
}

async function checkoutRequest(
  options: HttpCheckoutOptions,
  fetchImpl: typeof fetch,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, string>,
): Promise<unknown | undefined> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'X-Api-Key': options.apiKey,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, options.baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Status strings pass through. This adaptor does not map them. */
function decodePayment(payload: unknown, orderId?: string): CheckoutPayment {
  const parsed = paymentBody.safeParse(payload);
  if (!parsed.success) throw new Error('checkout-unavailable');
  return {
    id: parsed.data.paymentId,
    orderId: orderId ?? parsed.data.merchantOrderId,
    amount: parsed.data.amountOut,
    depositAddress: parsed.data.depositAddress,
    status: parsed.data.status,
  };
}
