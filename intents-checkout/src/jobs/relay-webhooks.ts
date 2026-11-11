import type { RelayWebhooks } from '../ports/inbound/relay-webhooks.js';

export const WEBHOOK_RELAY_INTERVAL_MS = 10_000;

export type RelayLog = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

/** Starts webhook delivery. Returns a function that stops it. */
export function startWebhookRelay(relay: RelayWebhooks, log: RelayLog, intervalMs = WEBHOOK_RELAY_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    log.info({ msg: 'relaying webhooks' }, 'relaying webhooks');
    void relay.relayOnce(new Date()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'webhook relay failed';
      log.error({ msg: 'webhook relay failed', message }, 'webhook relay failed');
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
