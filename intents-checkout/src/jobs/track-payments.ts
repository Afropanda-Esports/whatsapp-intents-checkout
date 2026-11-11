import type { TrackPayments } from '../ports/inbound/track-payments.js';

export const PAYMENT_POLL_INTERVAL_MS = 10_000;

export type PollLog = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

/** Starts the status poll. Returns a function that stops it. */
export function startPaymentPoller(track: TrackPayments, log: PollLog, intervalMs = PAYMENT_POLL_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    log.info({ msg: 'polling payments' }, 'polling payments');
    void track.trackOnce().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'poll failed';
      log.error({ msg: 'payment poll failed', message }, 'payment poll failed');
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
