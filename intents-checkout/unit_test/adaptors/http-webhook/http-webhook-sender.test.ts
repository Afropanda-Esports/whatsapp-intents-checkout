import { describe, expect, it } from 'vitest';
import { createHttpWebhookSender } from '../../../src/adaptors/http-webhook/http-webhook-sender.js';

const DELIVERY = { url: 'https://merchant.example/hooks', body: '{"id":"evt"}', signature: 't=1,v1=abc' };

function senderReturning(outcome: () => Promise<Response>) {
  return createHttpWebhookSender((async () => outcome()) as typeof fetch);
}

describe('createHttpWebhookSender', () => {
  it('delivers on a 2xx', async () => {
    const sender = senderReturning(async () => new Response(null, { status: 204 }));
    await expect(sender.send(DELIVERY)).resolves.toEqual({ delivered: true });
  });

  it('names the status of a non-2xx', async () => {
    const sender = senderReturning(async () => new Response('Not Found', { status: 404 }));
    await expect(sender.send(DELIVERY)).resolves.toEqual({ delivered: false, reason: 'status 404' });
  });

  it('reports a timeout', async () => {
    const sender = senderReturning(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(sender.send(DELIVERY)).resolves.toEqual({ delivered: false, reason: 'timeout' });
  });

  it('reports the cause of a refused redirect or network error', async () => {
    const sender = senderReturning(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    await expect(sender.send(DELIVERY)).resolves.toEqual({
      delivered: false,
      reason: 'request failed: unexpected redirect',
    });
  });
});
