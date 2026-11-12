import { z } from 'zod';
import type { MerchantOrder } from '../../domain/conversation/types.js';
import type { MerchantOrders } from '../../ports/outbound/merchant-orders.js';
import { pandaPayRequest, type PandaPayOptions } from './panda-pay-http.js';

const orderBody = z.object({
  id: z.string(),
  sku: z.string(),
  conversationId: z.string(),
});

const voucherBody = z.object({
  code: z.string().nullable(),
});

export function createHttpPandaPayOrders(options: PandaPayOptions): MerchantOrders {
  const transport = {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  return {
    async createOrder(input) {
      const payload = await pandaPayRequest({
        ...transport,
        path: '/orders/v1',
        method: 'POST',
        body: { sku: input.sku, conversationId: input.conversationId },
      });
      const parsed = orderBody.safeParse(payload);
      if (!parsed.success) throw new Error('order-unavailable');
      const order: MerchantOrder = {
        id: parsed.data.id,
        sku: parsed.data.sku,
        conversationId: parsed.data.conversationId,
      };
      return order;
    },
    async markFulfilled(orderId) {
      const payload = await pandaPayRequest({
        ...transport,
        path: `/orders/v1/${encodeURIComponent(orderId)}/fulfilment`,
        method: 'POST',
        body: {},
      });
      if (payload === undefined) throw new Error('order-unavailable');
    },
    async readVoucher(orderId) {
      const payload = await pandaPayRequest({
        ...transport,
        path: `/orders/v1/${encodeURIComponent(orderId)}/voucher`,
        method: 'GET',
      });
      const parsed = voucherBody.safeParse(payload);
      if (!parsed.success || parsed.data.code === null || parsed.data.code.length === 0) return null;
      return parsed.data.code;
    },
  };
}
