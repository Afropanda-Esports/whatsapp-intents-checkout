import { applyStatus } from './apply-status.js';
import { paymentResource } from './payment-resource.js';
import { paymentWebhook } from '../notification/payment-webhook.js';
import { webhookEnvelope } from '../notification/webhook-body.js';
import type { Payment } from './types.js';
import type { PaymentRepository, OutboxInsert } from '../../ports/outbound/payment-repository.js';
import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';

export type TrackPayments = {
  trackOnce(): Promise<void>;
};

export type TrackPaymentsDeps = {
  payments: Pick<PaymentRepository, 'listNonTerminal' | 'updateWithEvent'>;
  statuses: Pick<IntentsGateway, 'getStatus'>;
  merchants: Pick<MerchantDirectory, 'getWebhookTarget'>;
  publicBaseUrl: string;
  newEventId: () => string;
  clock: () => Date;
  onSkip: (info: { paymentId: string; correlationId: string }) => void;
};

/** One pass over every payment that is not SETTLED, EXPIRED, RETURNED, or FAILED. */
export function createTrackPayments(deps: TrackPaymentsDeps): TrackPayments {
  return {
    async trackOnce() {
      const open = await deps.payments.listNonTerminal();
      for (const payment of open) {
        await trackOne(deps, payment);
      }
    },
  };
}

async function trackOne(deps: TrackPaymentsDeps, payment: Payment): Promise<void> {
  const snapshot = await deps.statuses.getStatus({
    depositAddress: payment.depositAddress,
    depositMemo: payment.depositMemo,
  });
  if (snapshot === undefined) {
    deps.onSkip({ paymentId: payment.id, correlationId: payment.id });
    return;
  }
  const applied = applyStatus(payment, snapshot, deps.clock());
  if (applied.event === undefined) return;
  const outbox = await outboxFor(deps, applied.payment);
  await deps.payments.updateWithEvent(applied.payment, applied.event, outbox);
}

async function outboxFor(deps: TrackPaymentsDeps, payment: Payment): Promise<OutboxInsert[]> {
  const type = paymentWebhook(payment.status);
  if (type === undefined) return [];
  const target = await deps.merchants.getWebhookTarget(payment.merchantId);
  if (target === undefined || target.url.length === 0) return [];
  const eventId = deps.newEventId();
  const occurredAt = deps.clock().toISOString();
  return [
    {
      id: eventId,
      type,
      payload: webhookEnvelope({
        eventId,
        type,
        occurredAt,
        data: paymentResource(payment, deps.publicBaseUrl),
      }),
    },
  ];
}
