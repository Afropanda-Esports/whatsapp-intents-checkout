import { describe, expect, it, vi } from 'vitest';
import { webhookEnvelope } from '../../src/domain/notification/webhook-body.js';
import { createRelayWebhooks } from '../../src/domain/notification/relay-webhooks.js';
import { paymentResource } from '../../src/domain/payment/payment-resource.js';
import type { Payment } from '../../src/domain/payment/types.js';
import type { DueOutboxEvent } from '../../src/ports/outbound/outbox-store.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

function payment(): Payment {
  return {
    id: 'pay-1',
    merchantId: 'merchant-1',
    merchantOrderId: 'PPA-1',
    status: 'SETTLED',
    originAsset: 'nep141:origin',
    destinationAsset: 'nep141:usdc',
    amountOut: '1000000',
    amountIn: '1010000',
    minAmountIn: '1000000',
    refundFee: null,
    depositAddress: 'TDeposit',
    depositMemo: null,
    refundTo: 'TCustomer',
    confidential: false,
    deadline: '2026-11-11T12:30:00.000Z',
    depositedAmount: '15082000',
    settledAmount: '1000000',
    refundedAmount: '0',
    fulfilledAt: null,
    originTxHashes: [],
    destinationTxHashes: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function due(attempts: number): DueOutboxEvent {
  return {
    id: 'event-1',
    merchantId: 'merchant-1',
    type: 'payment.settled',
    attempts,
    createdAt: NOW,
    payload: webhookEnvelope({
      eventId: 'event-1',
      type: 'payment.settled',
      occurredAt: NOW.toISOString(),
      data: paymentResource(payment(), 'https://checkout.example'),
    }),
  };
}

describe('relayWebhooks', () => {
  it('logs the fifth failure and leaves the row for another attempt', async () => {
    const onFifthFailure = vi.fn();
    const onFailure = vi.fn();
    const markFailed = vi.fn(async (_id: string, attempts: number) => attempts);
    const sender = vi.fn(async () => ({ delivered: false as const, reason: 'status 404' }));
    const relay = createRelayWebhooks({
      outbox: {
        claimDue: async () => [due(4)],
        markDelivered: vi.fn(async () => undefined),
        markFailed,
      },
      merchants: { getWebhookTarget: async () => ({ url: 'https://merchant.example/hooks?token=t', secret: 'secret' }) },
      sender: { send: sender },
      onFifthFailure,
      onFailure,
      onError: () => undefined,
    });
    await relay.relayOnce(NOW);
    expect(sender).toHaveBeenCalledOnce();
    expect(markFailed).toHaveBeenCalledWith('event-1', 5, new Date(NOW.getTime() + 480_000));
    expect(onFailure).toHaveBeenCalledWith({
      eventId: 'event-1',
      type: 'payment.settled',
      attempts: 5,
      target: 'merchant.example/hooks',
      reason: 'status 404',
    });
    expect(onFifthFailure).toHaveBeenCalledWith({ eventId: 'event-1' });
  });

  it('does not report a failure when the event is delivered', async () => {
    const onFailure = vi.fn();
    const markDelivered = vi.fn(async () => undefined);
    const relay = createRelayWebhooks({
      outbox: { claimDue: async () => [due(0)], markDelivered, markFailed: vi.fn() },
      merchants: { getWebhookTarget: async () => ({ url: 'https://merchant.example/hooks', secret: 'secret' }) },
      sender: { send: async () => ({ delivered: true as const }) },
      onFifthFailure: () => undefined,
      onFailure,
      onError: () => undefined,
    });
    await relay.relayOnce(NOW);
    expect(markDelivered).toHaveBeenCalledWith('event-1', NOW);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does not burn an attempt when the webhook URL is empty', async () => {
    const markFailed = vi.fn();
    const sender = vi.fn();
    const relay = createRelayWebhooks({
      outbox: {
        claimDue: async () => [due(0)],
        markDelivered: vi.fn(async () => undefined),
        markFailed,
      },
      merchants: { getWebhookTarget: async () => ({ url: '', secret: 'secret' }) },
      sender: { send: sender },
      onFifthFailure: () => undefined,
      onFailure: () => undefined,
      onError: () => undefined,
    });
    await relay.relayOnce(NOW);
    expect(sender).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});
