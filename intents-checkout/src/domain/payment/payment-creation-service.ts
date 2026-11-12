import { DomainError } from '../domain-error.js';
import { isPositiveBaseUnits } from '../shared/money.js';
import type { CreatePaymentInput, CreatePaymentResult, NewPayment, Payment, SignedQuote } from './types.js';
import { QUOTE_WAITING_TIME_MS, type PaymentCreationDeps } from './payment-service-deps.js';

export type CreatePayment = {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
};

/**
 * Creates a payment for a merchant order: one 1Click EXACT_OUTPUT quote that settles exactly
 * `amountOut` of the destination asset into the treasury account. Idempotent on merchantOrderId.
 */
export function createPaymentCreationService(deps: PaymentCreationDeps): CreatePayment {
  return {
    async createPayment(input) {
      validate(input);
      const confidential = input.confidential ?? false;

      const existing = await deps.payments.findByMerchantOrder(input.merchantId, input.merchantOrderId);
      if (existing !== undefined) return replay(existing, input, confidential);
      if (!deps.settings.checkoutEnabled) throw new DomainError('checkout-disabled');

      const recipient = deps.settings.treasuryAccountId;
      if (recipient === undefined) throw new DomainError('quote-unavailable');

      await assertSupported(deps, input.originAsset);

      const deadline = new Date(
        deps.clock().getTime() + deps.settings.paymentWindowMinutes * 60_000,
      ).toISOString();
      const quote = await deps.quotes.requestQuote({
        originAsset: input.originAsset,
        destinationAsset: deps.settings.destinationAssetId,
        amountOut: input.amountOut,
        recipient,
        refundTo: input.refundTo,
        deadline,
        slippageBps: deps.settings.slippageBps,
        quoteWaitingTimeMs: QUOTE_WAITING_TIME_MS,
      });
      // EXACT_OUTPUT must echo the amount we asked for; anything else is not a quote we can act on.
      if (quote.terms.amountOut !== input.amountOut) throw new DomainError('quote-unavailable');

      const inserted = await deps.payments.insertWithEvent(
        newPayment(input, confidential, deps.settings.destinationAssetId, quote, deadline),
      );
      if (inserted.status === 'inserted') return { payment: inserted.payment, created: true };

      // Lost a concurrent insert for the same order: the winner's row is the payment.
      const winner = await deps.payments.findByMerchantOrder(input.merchantId, input.merchantOrderId);
      if (winner === undefined) throw new DomainError('quote-unavailable');
      return replay(winner, input, confidential);
    },
  };
}

function validate(input: CreatePaymentInput): void {
  const errors: Array<{ path: string; message: string }> = [];
  if (!isPositiveBaseUnits(input.amountOut)) {
    errors.push({ path: 'amountOut', message: 'must be a positive base-unit integer string (max 78 digits)' });
  }
  if (input.confidential === true) {
    errors.push({ path: 'confidential', message: 'confidential checkout is not available' });
  }
  if (errors.length > 0) throw new DomainError('invalid-request', { errors });
}

function replay(existing: Payment, input: CreatePaymentInput, confidential: boolean): CreatePaymentResult {
  const same =
    existing.amountOut === input.amountOut &&
    existing.originAsset === input.originAsset &&
    existing.refundTo === input.refundTo &&
    existing.confidential === confidential;
  if (!same) throw new DomainError('order-conflict', { paymentId: existing.id });
  return { payment: existing, created: false };
}

async function assertSupported(deps: PaymentCreationDeps, originAsset: string): Promise<void> {
  let assets;
  try {
    assets = await deps.assets.listAssets();
  } catch {
    throw new DomainError('quote-unavailable');
  }
  if (!assets.some((asset) => asset.assetId === originAsset)) {
    throw new DomainError('unsupported-asset', { originAsset });
  }
}

function newPayment(
  input: CreatePaymentInput,
  confidential: boolean,
  destinationAsset: string,
  quote: SignedQuote,
  requestedDeadline: string,
): NewPayment {
  return {
    merchantId: input.merchantId,
    merchantOrderId: input.merchantOrderId,
    status: 'AWAITING_DEPOSIT',
    originAsset: input.originAsset,
    destinationAsset,
    amountOut: input.amountOut,
    amountIn: quote.terms.amountIn,
    minAmountIn: quote.terms.minAmountIn,
    depositAddress: quote.terms.depositAddress,
    depositMemo: quote.terms.depositMemo,
    refundTo: input.refundTo,
    confidential,
    deadline: quote.terms.deadline ?? requestedDeadline,
    quote: quote.raw,
  };
}
