import type { Pool } from 'pg';
import type { ChainTx, NewPayment, Payment, PaymentStatus, PaymentStatusEvent } from '../../domain/payment/types.js';
import type { PaymentRepository } from '../../ports/outbound/payment-repository.js';

const UNIQUE_VIOLATION = '23505';

type PaymentRow = {
  id: string;
  merchant_id: string;
  merchant_order_id: string;
  status: string;
  origin_asset: string;
  destination_asset: string;
  amount_out: string;
  amount_in: string;
  min_amount_in: string;
  deposit_address: string;
  deposit_memo: string | null;
  refund_to: string;
  confidential: boolean;
  deadline: Date;
  deposited_amount: string | null;
  settled_amount: string | null;
  refunded_amount: string;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, merchant_id, merchant_order_id, status, origin_asset, destination_asset,
  amount_out::text AS amount_out, amount_in::text AS amount_in, min_amount_in::text AS min_amount_in,
  deposit_address, deposit_memo, refund_to, confidential, deadline,
  deposited_amount::text AS deposited_amount, settled_amount::text AS settled_amount,
  refunded_amount::text AS refunded_amount, created_at, updated_at`;

export function createPostgresPaymentRepository(pool: Pool): PaymentRepository {
  return {
    async findById(merchantId, paymentId) {
      const result = await pool.query<PaymentRow>(
        `SELECT ${COLUMNS} FROM payments WHERE merchant_id = $1 AND id = $2`,
        [merchantId, paymentId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return { ...toPayment(row), ...(await latestHashes(pool, row.id)) };
    },

    async findByMerchantOrder(merchantId, merchantOrderId) {
      const result = await pool.query<PaymentRow>(
        `SELECT ${COLUMNS} FROM payments WHERE merchant_id = $1 AND merchant_order_id = $2`,
        [merchantId, merchantOrderId],
      );
      return result.rows[0] === undefined ? undefined : toPayment(result.rows[0]);
    },

    async insertWithEvent(payment) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query<PaymentRow>(
          `INSERT INTO payments (merchant_id, merchant_order_id, status, origin_asset, destination_asset,
             amount_out, amount_in, min_amount_in, deposit_address, deposit_memo, refund_to, confidential,
             deadline, quote)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11, $12, $13, $14)
           RETURNING ${COLUMNS}`,
          insertParams(payment),
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('payment insert returned no row');
        await client.query(
          'INSERT INTO payment_events (payment_id, from_status, to_status) VALUES ($1, NULL, $2)',
          [row.id, payment.status],
        );
        await client.query('COMMIT');
        return { status: 'inserted', payment: toPayment(row) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (sqlState(error) === UNIQUE_VIOLATION) return { status: 'duplicate' };
        throw error;
      } finally {
        client.release();
      }
    },

    async listNonTerminal() {
      const result = await pool.query<PaymentRow>(
        `SELECT ${COLUMNS} FROM payments
         WHERE status NOT IN ('SETTLED', 'EXPIRED', 'RETURNED', 'FAILED')
         ORDER BY created_at`,
      );
      return result.rows.map((row) => toPayment(row));
    },

    async updateWithEvent(payment, event) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query<PaymentRow>(
          `UPDATE payments
             SET status = $2, deposited_amount = $3::numeric, settled_amount = $4::numeric,
                 one_click_status = $5, updated_at = now()
           WHERE id = $1
           RETURNING ${COLUMNS}`,
          [payment.id, payment.status, payment.depositedAmount, payment.settledAmount, event.oneClickStatus],
        );
        const row = updated.rows[0];
        if (row === undefined) throw new Error('payment update matched no row');
        await client.query(
          `INSERT INTO payment_events (payment_id, from_status, to_status, one_click_status, detail)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [payment.id, event.fromStatus, event.toStatus, event.oneClickStatus, JSON.stringify(eventDetail(event))],
        );
        await client.query('COMMIT');
        return {
          ...toPayment(row),
          originTxHashes: event.originTxHashes,
          destinationTxHashes: event.destinationTxHashes,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function insertParams(payment: NewPayment): unknown[] {
  return [
    payment.merchantId,
    payment.merchantOrderId,
    payment.status,
    payment.originAsset,
    payment.destinationAsset,
    payment.amountOut,
    payment.amountIn,
    payment.minAmountIn,
    payment.depositAddress,
    payment.depositMemo,
    payment.refundTo,
    payment.confidential,
    payment.deadline,
    JSON.stringify(payment.quote),
  ];
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantOrderId: row.merchant_order_id,
    status: row.status as PaymentStatus,
    originAsset: row.origin_asset,
    destinationAsset: row.destination_asset,
    amountOut: row.amount_out,
    amountIn: row.amount_in,
    minAmountIn: row.min_amount_in,
    depositAddress: row.deposit_address,
    depositMemo: row.deposit_memo,
    refundTo: row.refund_to,
    confidential: row.confidential,
    deadline: row.deadline.toISOString(),
    depositedAmount: row.deposited_amount,
    settledAmount: row.settled_amount,
    refundedAmount: row.refunded_amount,
    originTxHashes: [],
    destinationTxHashes: [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function eventDetail(event: PaymentStatusEvent): { originTxHashes: ChainTx[]; destinationTxHashes: ChainTx[] } {
  return { originTxHashes: event.originTxHashes, destinationTxHashes: event.destinationTxHashes };
}

async function latestHashes(pool: Pool, paymentId: string): Promise<Pick<Payment, 'originTxHashes' | 'destinationTxHashes'>> {
  const result = await pool.query<{ detail: unknown }>(
    `SELECT detail FROM payment_events
     WHERE payment_id = $1 AND detail IS NOT NULL
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [paymentId],
  );
  return hashesFrom(result.rows[0]?.detail);
}

function hashesFrom(detail: unknown): Pick<Payment, 'originTxHashes' | 'destinationTxHashes'> {
  if (typeof detail !== 'object' || detail === null) return { originTxHashes: [], destinationTxHashes: [] };
  const record = detail as { originTxHashes?: unknown; destinationTxHashes?: unknown };
  return { originTxHashes: asTxs(record.originTxHashes), destinationTxHashes: asTxs(record.destinationTxHashes) };
}

function asTxs(value: unknown): ChainTx[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const tx = item as { hash?: unknown; explorerUrl?: unknown };
    if (typeof tx.hash !== 'string' || typeof tx.explorerUrl !== 'string') return [];
    return [{ hash: tx.hash, explorerUrl: tx.explorerUrl }];
  });
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
