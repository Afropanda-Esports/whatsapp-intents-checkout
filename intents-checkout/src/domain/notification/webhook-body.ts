import type { ChainTx } from '../payment/types.js';
import { orderedResource, type PaymentResource } from '../payment/payment-resource.js';

export type WebhookEnvelope = {
  eventId: string;
  type: string;
  occurredAt: string;
  data: PaymentResource;
  _links: { self: { href: string } };
};

/** Canonical bytes. Key order is fixed so a retry signs the same body. */
export function webhookJson(input: { eventId: string; type: string; occurredAt: string; data: PaymentResource }): string {
  const data = orderedResource(input.data);
  return JSON.stringify({
    eventId: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt,
    data,
    _links: { self: { href: data._links.self.href } },
  });
}

export function webhookEnvelope(input: {
  eventId: string;
  type: string;
  occurredAt: string;
  data: PaymentResource;
}): WebhookEnvelope {
  const data = orderedResource(input.data);
  return {
    eventId: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt,
    data,
    _links: { self: { href: data._links.self.href } },
  };
}

/** Rebuilds the signed bytes from a payload Postgres has parsed. Undefined when the payload is not a webhook. */
export function webhookJsonFromStored(payload: unknown): string | undefined {
  const parsed = envelopeFrom(payload);
  if (parsed === undefined) return undefined;
  return webhookJson(parsed);
}

function envelopeFrom(payload: unknown): { eventId: string; type: string; occurredAt: string; data: PaymentResource } | undefined {
  if (!isRecord(payload)) return undefined;
  const eventId = text(payload['eventId']);
  const type = text(payload['type']);
  const occurredAt = text(payload['occurredAt']);
  const data = resourceFrom(payload['data']);
  if (eventId === undefined || type === undefined || occurredAt === undefined || data === undefined) return undefined;
  return { eventId, type, occurredAt, data };
}

function resourceFrom(value: unknown): PaymentResource | undefined {
  if (!isRecord(value) || !isRecord(value['_links'])) return undefined;
  const links = value['_links'];
  if (!isRecord(links['self'])) return undefined;
  const href = text(links['self']['href']);
  const paymentId = text(value['paymentId']);
  const merchantOrderId = text(value['merchantOrderId']);
  const status = text(value['status']);
  const originAsset = text(value['originAsset']);
  const destinationAsset = text(value['destinationAsset']);
  const amountOut = text(value['amountOut']);
  const amountIn = text(value['amountIn']);
  const minAmountIn = text(value['minAmountIn']);
  const depositAddress = text(value['depositAddress']);
  const depositMemo = nullableText(value['depositMemo']);
  const deadline = text(value['deadline']);
  const confidential = value['confidential'];
  const depositedAmount = nullableText(value['depositedAmount']);
  const settledAmount = nullableText(value['settledAmount']);
  const refundedAmount = text(value['refundedAmount']);
  const createdAt = text(value['createdAt']);
  const updatedAt = text(value['updatedAt']);
  if (
    href === undefined ||
    paymentId === undefined ||
    merchantOrderId === undefined ||
    status === undefined ||
    originAsset === undefined ||
    destinationAsset === undefined ||
    amountOut === undefined ||
    amountIn === undefined ||
    minAmountIn === undefined ||
    depositAddress === undefined ||
    depositMemo === 'invalid' ||
    deadline === undefined ||
    typeof confidential !== 'boolean' ||
    depositedAmount === 'invalid' ||
    settledAmount === 'invalid' ||
    refundedAmount === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  return orderedResource({
    paymentId,
    merchantOrderId,
    status,
    originAsset,
    destinationAsset,
    amountOut,
    amountIn,
    minAmountIn,
    depositAddress,
    depositMemo,
    deadline,
    confidential,
    depositedAmount,
    settledAmount,
    refundedAmount,
    originTxHashes: txs(value['originTxHashes']),
    destinationTxHashes: txs(value['destinationTxHashes']),
    createdAt,
    updatedAt,
    _links: { self: { href } },
  });
}

function txs(value: unknown): ChainTx[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const hash = text(item['hash']);
    const explorerUrl = text(item['explorerUrl']);
    if (hash === undefined || explorerUrl === undefined) return [];
    return [{ hash, explorerUrl }];
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableText(value: unknown): string | null | 'invalid' {
  if (value === null) return null;
  return typeof value === 'string' ? value : 'invalid';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
