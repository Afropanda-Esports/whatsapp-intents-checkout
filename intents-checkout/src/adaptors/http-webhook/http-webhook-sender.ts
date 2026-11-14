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
        if (response.ok) return { delivered: true };
        return { delivered: false, reason: `status ${response.status}` };
      } catch (error) {
        return { delivered: false, reason: failureReason(error) };
      }
    },
  };
}

function failureReason(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && cause.message.length > 0) return `request failed: ${cause.message}`;
  if (error instanceof Error && error.message.length > 0) return `request failed: ${error.message}`;
  return 'request failed';
}
