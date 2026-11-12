import type { OutboxInsert } from './payment-repository.js';

export const DISBURSEMENT_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'ESCALATED',
  'EXECUTING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
] as const;

export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export type Disbursement = {
  id: string;
  paymentId: string;
  status: DisbursementStatus;
  amount: string;
  reason: string;
  policyRequestId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewDisbursement = {
  id: string;
  paymentId: string;
  payee: string;
  amount: string;
  reason: string;
  status: Extract<DisbursementStatus, 'APPROVED' | 'ESCALATED'>;
  policyRequestId: string;
  policyTxHash: string;
  depositAddress: string;
  quote: unknown;
};

export type DisbursementRepository = {
  insert(row: NewDisbursement): Promise<Disbursement>;
  listByPayment(paymentId: string): Promise<Disbursement[]>;
  setStatus(id: string, status: DisbursementStatus): Promise<Disbursement>;
  /**
   * Marks the refund completed, adds its amount to the payment with numeric arithmetic,
   * and writes the outbox row. The payment status is left unchanged.
   */
  complete(input: { merchantId: string; disbursementId: string; outbox: OutboxInsert }): Promise<Disbursement>;
};
