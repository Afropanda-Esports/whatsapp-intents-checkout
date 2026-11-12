import { describe, expect, it } from 'vitest';
import { createHttpIntentsCheckoutPayments } from '../../src/adaptors/intents-checkout/http-intents-checkout-payments.js';
import { createHttpPandaPayCatalog } from '../../src/adaptors/panda-pay/http-panda-pay-catalog.js';
import { createHttpPandaPayOrders } from '../../src/adaptors/panda-pay/http-panda-pay-orders.js';

function stubFetch(payload: unknown): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return undefined;
  return headers[name];
}

describe('merchant and checkout HTTP adaptors', () => {
  it('sends X-Api-Key and does not let the caller choose a destination', async () => {
    const catalog = stubFetch({ items: [{ sku: 'psn-10', name: 'PSN 10', price: '1000000' }] });
    const listed = await createHttpPandaPayCatalog({
      baseUrl: 'http://panda.test',
      apiKey: 'panda-key',
      fetchImpl: catalog.fetchImpl,
    }).listCatalog();
    expect(listed).toEqual([{ sku: 'psn-10', name: 'PSN 10', price: '1000000' }]);
    expect(header(catalog.calls[0]?.init ?? {}, 'X-Api-Key')).toBe('panda-key');

    const orders = stubFetch({ id: 'ord-1', sku: 'psn-10', conversationId: 'c1' });
    await createHttpPandaPayOrders({
      baseUrl: 'http://panda.test',
      apiKey: 'panda-key',
      fetchImpl: orders.fetchImpl,
    }).createOrder({ sku: 'psn-10', conversationId: 'c1' });
    expect(JSON.parse(String(orders.calls[0]?.init.body))).toEqual({ sku: 'psn-10', conversationId: 'c1' });
    expect(header(orders.calls[0]?.init ?? {}, 'X-Api-Key')).toBe('panda-key');

    const checkout = stubFetch({
      paymentId: 'pay-1',
      merchantOrderId: 'ord-1',
      status: 'AWAITING_DEPOSIT',
      amountOut: '1000000',
      depositAddress: 'dep-ord-1',
    });
    const payment = await createHttpIntentsCheckoutPayments({
      baseUrl: 'http://checkout.test',
      apiKey: 'checkout-key',
      fetchImpl: checkout.fetchImpl,
    }).createPayment({ orderId: 'ord-1', amount: '1000000' });
    expect(payment.status).toBe('AWAITING_DEPOSIT');
    expect(header(checkout.calls[0]?.init ?? {}, 'X-Api-Key')).toBe('checkout-key');
    expect(JSON.parse(String(checkout.calls[0]?.init.body))).toEqual({
      merchantOrderId: 'ord-1',
      amountOut: '1000000',
      originAsset: 'usdt-tron',
      refundTo: 'merchant-origin-record',
    });
  });

  it('passes checkout status strings through without mapping them', async () => {
    const checkout = stubFetch({
      paymentId: 'pay-1',
      merchantOrderId: 'ord-1',
      status: 'SUCCESS',
      amountOut: '1000000',
      depositAddress: 'dep-ord-1',
    });
    const payment = await createHttpIntentsCheckoutPayments({
      baseUrl: 'http://checkout.test',
      apiKey: 'checkout-key',
      fetchImpl: checkout.fetchImpl,
    }).readPayment('pay-1');
    expect(payment.status).toBe('SUCCESS');
  });
});
