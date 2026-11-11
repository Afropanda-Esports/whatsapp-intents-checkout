import { applyStatus } from './apply-status.js';
import type { Payment } from './types.js';
import type { PaymentRepository } from '../../ports/outbound/payment-repository.js';
import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';

export type TrackPayments = {
  trackOnce(): Promise<void>;
};

export type TrackPaymentsDeps = {
  payments: Pick<PaymentRepository, 'listNonTerminal' | 'updateWithEvent'>;
  statuses: Pick<IntentsGateway, 'getStatus'>;
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
  await deps.payments.updateWithEvent(applied.payment, applied.event);
}
