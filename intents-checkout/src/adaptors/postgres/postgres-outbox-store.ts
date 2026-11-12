import type { Pool } from 'pg';
import type { DueOutboxEvent, OutboxStore } from '../../ports/outbound/outbox-store.js';

type OutboxRow = {
  id: string;
  merchant_id: string;
  type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
};

export function createPostgresOutboxStore(pool: Pool): OutboxStore {
  return {
    async claimDue(now) {
      const result = await pool.query<OutboxRow>(
        `SELECT id, merchant_id, type, payload, attempts, created_at
         FROM outbox_events
         WHERE delivered_at IS NULL
           AND created_at > $1::timestamptz - interval '24 hours'
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
         ORDER BY created_at`,
        [now],
      );
      return result.rows.map(toDue);
    },

    async markDelivered(id, deliveredAt) {
      const result = await pool.query(
        `UPDATE outbox_events SET delivered_at = $2 WHERE id = $1 AND delivered_at IS NULL`,
        [id, deliveredAt],
      );
      if (result.rowCount !== 1) throw new Error('outbox delivery matched no row');
    },

    async markFailed(id, attempts, nextAttemptAt) {
      const result = await pool.query<{ attempts: number }>(
        `UPDATE outbox_events
           SET attempts = $2, next_attempt_at = $3
         WHERE id = $1 AND delivered_at IS NULL
         RETURNING attempts`,
        [id, attempts, nextAttemptAt],
      );
      const stored = result.rows[0]?.attempts;
      if (stored === undefined) throw new Error('outbox failure matched no row');
      return stored;
    },
  };
}

function toDue(row: OutboxRow): DueOutboxEvent {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}
