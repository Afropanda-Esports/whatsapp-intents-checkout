import { retryDelayMs } from './webhook-retry.js';
import { webhookJsonFromStored } from './webhook-body.js';
import { checkoutSignature } from './webhook-signature.js';
import type { DueOutboxEvent, OutboxStore } from '../../ports/outbound/outbox-store.js';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';
import type { WebhookSender } from '../../ports/outbound/webhook-sender.js';

export type RelayWebhooks = {
  relayOnce(now: Date): Promise<void>;
};

export type RelayWebhooksDeps = {
  outbox: Pick<OutboxStore, 'claimDue' | 'markDelivered' | 'markFailed'>;
  merchants: Pick<MerchantDirectory, 'getWebhookTarget'>;
  sender: WebhookSender;
  onFifthFailure: (info: { eventId: string }) => void;
  onError: (info: { eventId: string; message: string }) => void;
};

/** One pass over outbox rows that are due. A failed send stays in the outbox. */
export function createRelayWebhooks(deps: RelayWebhooksDeps): RelayWebhooks {
  return {
    async relayOnce(now) {
      const due = await deps.outbox.claimDue(now);
      for (const row of due) {
        try {
          await deliver(deps, row, now);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'webhook relay failed';
          deps.onError({ eventId: row.id, message });
        }
      }
    },
  };
}

async function deliver(deps: RelayWebhooksDeps, row: DueOutboxEvent, now: Date): Promise<void> {
  const target = await deps.merchants.getWebhookTarget(row.merchantId);
  if (target === undefined || target.url.length === 0) return;

  const body = webhookJsonFromStored(row.payload);
  if (body === undefined) {
    await recordFailure(deps, row, now);
    return;
  }
  const signature = checkoutSignature(target.secret, body, Math.floor(now.getTime() / 1000));
  const result = await deps.sender.send({ url: target.url, body, signature });
  if (result.delivered) {
    await deps.outbox.markDelivered(row.id, now);
    return;
  }
  await recordFailure(deps, row, now);
}

async function recordFailure(deps: RelayWebhooksDeps, row: DueOutboxEvent, now: Date): Promise<void> {
  const attempts = row.attempts + 1;
  const stored = await deps.outbox.markFailed(row.id, attempts, new Date(now.getTime() + retryDelayMs(attempts)));
  if (stored === 5) deps.onFifthFailure({ eventId: row.id });
}
