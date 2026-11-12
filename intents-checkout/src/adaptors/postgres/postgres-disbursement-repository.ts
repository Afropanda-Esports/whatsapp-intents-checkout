import type { Pool } from 'pg';
import type { Disbursement, DisbursementRepository, DisbursementStatus } from '../../ports/outbound/disbursement-repository.js';

type DisbursementRow = {
  id: string;
  payment_id: string;
  status: string;
  amount: string;
  reason: string | null;
  policy_request_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, payment_id, status, amount::text AS amount, reason, policy_request_id, created_at, updated_at`;

export function createPostgresDisbursementRepository(pool: Pool): DisbursementRepository {
  return {
    async insert(row) {
      const result = await pool.query<DisbursementRow>(
        `INSERT INTO disbursements
           (id, kind, payment_id, payee, amount, reason, status, policy_request_id, policy_tx_hashes,
            one_click_deposit_address, quote)
         VALUES ($1, 'REFUND', $2, $3, $4::numeric, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
         RETURNING ${COLUMNS}`,
        [
          row.id,
          row.paymentId,
          row.payee,
          row.amount,
          row.reason,
          row.status,
          row.policyRequestId,
          JSON.stringify([row.policyTxHash]),
          row.depositAddress,
          JSON.stringify(row.quote),
        ],
      );
      return toDisbursement(required(result.rows[0]));
    },

    async listByPayment(paymentId) {
      const result = await pool.query<DisbursementRow>(
        `SELECT ${COLUMNS} FROM disbursements WHERE payment_id = $1 AND kind = 'REFUND' ORDER BY created_at ASC, id ASC`,
        [paymentId],
      );
      return result.rows.map(toDisbursement);
    },

    async setStatus(id, status) {
      const result = await pool.query<DisbursementRow>(
        `UPDATE disbursements SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, status],
      );
      return toDisbursement(required(result.rows[0]));
    },

    async complete(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query<DisbursementRow>(`SELECT ${COLUMNS} FROM disbursements WHERE id = $1 FOR UPDATE`, [
          input.disbursementId,
        ]);
        const row = required(current.rows[0]);
        const updated = await client.query<DisbursementRow>(
          `UPDATE disbursements SET status = 'COMPLETED', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [input.disbursementId],
        );
        await client.query(
          `UPDATE payments
             SET refunded_amount = refunded_amount + $1::numeric, updated_at = now()
           WHERE id = $2 AND merchant_id = $3`,
          [row.amount, row.payment_id, input.merchantId],
        );
        await client.query(
          `INSERT INTO outbox_events (id, merchant_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [input.outbox.id, input.merchantId, input.outbox.type, JSON.stringify(input.outbox.payload)],
        );
        await client.query('COMMIT');
        return toDisbursement(required(updated.rows[0]));
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function toDisbursement(row: DisbursementRow): Disbursement {
  return {
    id: row.id,
    paymentId: row.payment_id,
    status: row.status as DisbursementStatus,
    amount: row.amount,
    reason: row.reason ?? '',
    policyRequestId: row.policy_request_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function required(row: DisbursementRow | undefined): DisbursementRow {
  if (row === undefined) throw new Error('disbursement row missing');
  return row;
}
