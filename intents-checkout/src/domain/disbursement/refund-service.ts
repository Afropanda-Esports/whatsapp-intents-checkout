import { DomainError } from '../domain-error.js';
import { exceedsBaseUnits, isPositiveBaseUnits, subtractBaseUnits } from '../shared/money.js';
import { quoteRequestRecipient } from './quote-recipient.js';
import { QUOTE_WAITING_TIME_MS, type PaymentSettings } from '../payment/payment-service-deps.js';
import type { Payment } from '../payment/types.js';
import type { WebhookEnvelope } from '../notification/webhook-body.js';
import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import type { DisbursementRepository } from '../../ports/outbound/disbursement-repository.js';
import type { PolicyLedger } from '../../ports/outbound/policy-ledger.js';
import { refundResource, type RefundResource } from './refund-resource.js';

export type RefundRequest = {
  amount: string;
  reason: string;
};

export type RefundService = {
  request(merchantId: string, paymentId: string, input: RefundRequest): Promise<RefundResource>;
  list(merchantId: string, paymentId: string): Promise<RefundResource[]>;
};

export type RefundServiceDeps = {
  getPayment: (merchantId: string, paymentId: string) => Promise<Payment>;
  disbursements: DisbursementRepository;
  quotes: Pick<IntentsGateway, 'requestQuote'>;
  ledger?: PolicyLedger;
  clock: () => Date;
  newId: () => string;
  publicBaseUrl: string;
  settings: Pick<PaymentSettings, 'treasuryAccountId' | 'slippageBps' | 'paymentWindowMinutes'>;
};

const NEP141 = 'nep141:';

/**
 * Quotes the customer's refund destination before reserving anything on the contract.
 * An escalated request is stored and returned. It is not executed and it does not emit
 * refund.escalated. A completed refund adds to refundedAmount and leaves the payment SETTLED.
 */
export function createRefundService(deps: RefundServiceDeps): RefundService {
  return {
    async request(merchantId, paymentId, input) {
      validate(input);
      const payment = await deps.getPayment(merchantId, paymentId);
      const refundable = refundableAmount(payment);
      if (payment.status !== 'SETTLED' || payment.fulfilledAt !== null || exceedsBaseUnits(input.amount, refundable)) {
        throw new DomainError('refund-not-allowed', { refundableAmount: refundable });
      }
      if (deps.ledger === undefined) throw new DomainError('policy-unavailable');
      const ledger = deps.ledger;

      const order = await ledger.getOrder(payment.id);
      if (order.status === 'unavailable') throw new DomainError('policy-unavailable');
      if (order.value === null) throw new DomainError('refund-not-allowed', { refundableAmount: refundable });

      const treasury = deps.settings.treasuryAccountId;
      if (treasury === undefined) throw new DomainError('quote-unavailable');
      const deadline = new Date(deps.clock().getTime() + deps.settings.paymentWindowMinutes * 60_000).toISOString();
      const quote = await deps.quotes.requestQuote({
        originAsset: payment.destinationAsset,
        destinationAsset: payment.originAsset,
        amountOut: input.amount,
        recipient: order.value.refundDestination,
        refundTo: treasury,
        deadline,
        slippageBps: deps.settings.slippageBps,
        quoteWaitingTimeMs: QUOTE_WAITING_TIME_MS,
      });
      if (quoteRequestRecipient(quote.raw) !== order.value.refundDestination) {
        throw new DomainError('refund-not-allowed', { refundableAmount: refundable });
      }

      const tokenAccount = tokenAccountId(payment.destinationAsset);
      if (tokenAccount === undefined) throw new DomainError('policy-unavailable');
      const balance = await ledger.storageBalance(tokenAccount, quote.terms.depositAddress);
      if (balance.status === 'unavailable') throw new DomainError('policy-unavailable');
      if (balance.status === 'unregistered') {
        const deposited = await ledger.storageDeposit(tokenAccount, quote.terms.depositAddress);
        if (deposited.status !== 'ok') throw new DomainError('policy-unavailable');
      }

      const requested = await ledger.requestRefund({ orderRef: payment.id, amount: input.amount });
      if (requested.status === 'rejected') {
        throw new DomainError('policy-rejected', { code: requested.code, txHash: requested.txHash });
      }
      if (requested.status === 'unavailable') throw new DomainError('policy-unavailable');
      const outcome = requestOutcome(requested.value);
      if (outcome === undefined) throw new DomainError('policy-unavailable');

      const stored = await deps.disbursements.insert({
        id: deps.newId(),
        paymentId: payment.id,
        payee: order.value.refundDestination,
        amount: input.amount,
        reason: input.reason,
        status: outcome.status === 'Approved' ? 'APPROVED' : 'ESCALATED',
        policyRequestId: outcome.requestId,
        policyTxHash: requested.txHash,
        depositAddress: quote.terms.depositAddress,
        quote: quote.raw,
      });
      if (outcome.status === 'Escalated') return resource(deps, stored);

      const executed = await ledger.executeRefund({
        requestId: outcome.requestId,
        depositAddress: quote.terms.depositAddress,
      });
      if (executed.status === 'rejected') {
        throw new DomainError('policy-rejected', { code: executed.code, txHash: executed.txHash });
      }
      if (executed.status === 'unavailable') throw new DomainError('policy-unavailable');

      const viewed = await ledger.getRequest(outcome.requestId);
      if (viewed.status !== 'ok' || viewed.value === null || viewed.value.status !== 'Executed') {
        return resource(deps, await deps.disbursements.setStatus(stored.id, 'EXECUTING'));
      }
      const completed = await deps.disbursements.complete({
        merchantId,
        disbursementId: stored.id,
        outbox: completedEvent(deps, stored.id, payment.id, input, stored.createdAt),
      });
      return resource(deps, completed);
    },

    async list(merchantId, paymentId) {
      const payment = await deps.getPayment(merchantId, paymentId);
      const rows = await deps.disbursements.listByPayment(payment.id);
      return rows.map((row) => resource(deps, row));
    },
  };
}

function validate(input: RefundRequest): void {
  const errors: Array<{ path: string; message: string }> = [];
  if (!isPositiveBaseUnits(input.amount)) {
    errors.push({ path: 'amount', message: 'must be a positive base-unit integer string (max 78 digits)' });
  }
  if (errors.length > 0) throw new DomainError('invalid-request', { errors });
}

function refundableAmount(payment: Payment): string {
  if (payment.settledAmount === null) return '0';
  return subtractBaseUnits(payment.settledAmount, payment.refundedAmount);
}

function tokenAccountId(assetId: string): string | undefined {
  if (!assetId.startsWith(NEP141)) return undefined;
  const account = assetId.slice(NEP141.length);
  return account.length > 0 ? account : undefined;
}

function requestOutcome(value: unknown): { requestId: string; status: 'Approved' | 'Escalated' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const requestId = record['request_id'];
  const status = record['status'];
  if (typeof requestId !== 'string' || !/^[0-9]+$/u.test(requestId)) return undefined;
  if (status !== 'Approved' && status !== 'Escalated') return undefined;
  return { requestId, status };
}

function resource(
  deps: RefundServiceDeps,
  row: { id: string; paymentId: string; status: string; amount: string; reason: string; createdAt: string; updatedAt: string },
): RefundResource {
  return refundResource({ ...row, publicBaseUrl: deps.publicBaseUrl });
}

function completedEvent(
  deps: RefundServiceDeps,
  refundId: string,
  paymentId: string,
  input: RefundRequest,
  createdAt: string,
): { id: string; type: string; payload: WebhookEnvelope } {
  const occurredAt = deps.clock().toISOString();
  const eventId = deps.newId();
  const data = refundResource({
    id: refundId,
    paymentId,
    status: 'COMPLETED',
    amount: input.amount,
    reason: input.reason,
    createdAt,
    updatedAt: occurredAt,
    publicBaseUrl: deps.publicBaseUrl,
  });
  return {
    id: eventId,
    type: 'refund.completed',
    payload: {
      eventId,
      type: 'refund.completed',
      occurredAt,
      data,
      _links: { self: { href: data._links.self.href } },
    },
  };
}
