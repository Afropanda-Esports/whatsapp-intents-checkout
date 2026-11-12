import type { WebhookSender } from '../../ports/outbound/webhook-sender.js';

const REQUEST_TIMEOUT_MS = 5_000;

/** POSTs the exact body. A redirect, a timeout, a network error, or a non-2xx is not delivered. */
export function createHttpWebhookSender(fetchImpl: typeof fetch = fetch): WebhookSender {
  return {
    async send(delivery) {
      try {
        const response = await fetchImpl(delivery.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-checkout-signature': delivery.signature,
          },
          body: delivery.body,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return { delivered: response.ok };
      } catch {
        return { delivered: false };
      }
    },
  };
}
