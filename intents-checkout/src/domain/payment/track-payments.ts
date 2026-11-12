import { applyStatus } from './apply-status.js';
import { paymentResource } from './payment-resource.js';
import { paymentWebhook } from '../notification/payment-webhook.js';
import { webhookEnvelope } from '../notification/webhook-body.js';
import type { Payment } from './types.js';
import type { PaymentRepository, OutboxInsert } from '../../ports/outbound/payment-repository.js';
import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';
import type { PolicyLedger } from '../../ports/outbound/policy-ledger.js';

export type TrackPayments = {
  trackOnce(): Promise<void>;
};

export type TrackSkip = {
  paymentId: string;
  correlationId: string;
  code?: string;
  reason?: string;
};

export type TrackPaymentsDeps = {
  payments: Pick<PaymentRepository, 'listNonTerminal' | 'updateWithEvent'>;
  statuses: Pick<IntentsGateway, 'getStatus'>;
  merchants: Pick<MerchantDirectory, 'getWebhookTarget'>;
  publicBaseUrl: string;
  newEventId: () => string;
  clock: () => Date;
  onSkip: (info: TrackSkip) => void;
  /** When set, a payment is marked SETTLED only after register_payment succeeds. */
  ledger?: PolicyLedger;
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
  if (deps.ledger !== undefined && applied.payment.status === 'SETTLED') {
    const registered = await registerSettled(deps, applied.payment);
    if (!registered) return;
  }
  const outbox = await outboxFor(deps, applied.payment);
  await deps.payments.updateWithEvent(applied.payment, applied.event, outbox);
}

/** False leaves the payment non-terminal so the next tick can try the same registration again. */
async function registerSettled(deps: TrackPaymentsDeps, payment: Payment): Promise<boolean> {
  const ledger = deps.ledger;
  if (ledger === undefined) return true;
  if (payment.settledAmount === null) {
    deps.onSkip({ paymentId: payment.id, correlationId: payment.id, reason: 'missing settled amount' });
    return false;
  }
  const outcome = await ledger.registerPayment({
    orderRef: payment.id,
    amountReceived: payment.settledAmount,
    refundDestination: payment.refundTo,
    originAsset: payment.originAsset,
  });
  if (outcome.status === 'ok') return true;
  if (outcome.status === 'rejected') {
    deps.onSkip({ paymentId: payment.id, correlationId: payment.id, code: outcome.code });
    return false;
  }
  deps.onSkip({ paymentId: payment.id, correlationId: payment.id, reason: 'policy-unavailable' });
  return false;
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
