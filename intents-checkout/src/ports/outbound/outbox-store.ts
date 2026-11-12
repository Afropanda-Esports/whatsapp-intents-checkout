export type DueOutboxEvent = {
  id: string;
  merchantId: string;
  type: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
};

export type OutboxStore = {
  /** Undelivered rows whose next attempt is due and whose created_at is inside the last 24 hours. */
  claimDue(now: Date): Promise<DueOutboxEvent[]>;
  markDelivered(id: string, deliveredAt: Date): Promise<void>;
  /** Stores the attempt count and the next time. Returns the stored attempt count. */
  markFailed(id: string, attempts: number, nextAttemptAt: Date): Promise<number>;
};
