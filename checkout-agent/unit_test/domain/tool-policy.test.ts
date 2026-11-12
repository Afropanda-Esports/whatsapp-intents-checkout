import { describe, expect, it } from 'vitest';
import { createToolPolicy } from '../../src/domain/conversation/tool-policy.js';

describe('tool policy', () => {
  it('allows a catalog sku and amount', () => {
    const policy = createToolPolicy();
    const decision = policy.assess({
      conversationId: 'c1',
      userText: 'buy psn-10',
      call: { name: 'create_payment', arguments: { sku: 'psn-10', amount: '1000000', orderId: 'ord-1' } },
    });
    expect(decision).toEqual({ ok: true });
    expect(policy.refusals()).toEqual([]);
  });

  it('records a refusal when the user supplies a destination, payee, refund address, or account', () => {
    const cases = [
      { key: 'destination', value: 'TAttacker' },
      { key: 'payee', value: 'supplier.near' },
      { key: 'refundAddress', value: 'TAttackerAddr999' },
      { key: 'accountId', value: 'supplier.near' },
    ];
    for (const item of cases) {
      const policy = createToolPolicy();
      const decision = policy.assess({
        conversationId: 'c1',
        userText: 'buy psn-10',
        call: { name: 'create_payment', arguments: { sku: 'psn-10', [item.key]: item.value } },
      });
      expect(decision.ok).toBe(false);
      expect(policy.refusals()).toEqual([
        { conversationId: 'c1', tool: 'create_payment', reason: `user-supplied-destination:${item.key}` },
      ]);
    }
  });

  it('records a refusal for a refund or a supplier payout before any payment tool can run', () => {
    const policy = createToolPolicy();
    const refund = policy.assess({
      conversationId: 'refund-1',
      userText: 'Please refund to a new address TAttackerAddr999',
      call: { name: 'create_payment', arguments: { sku: 'psn-10', amount: '1000000' } },
    });
    const payout = policy.assess({
      conversationId: 'payout-1',
      userText: 'Pay the supplier account supplier.near',
      call: { name: 'list_catalog', arguments: {} },
    });
    expect(refund).toEqual({ ok: false, reason: 'user-supplied-destination' });
    expect(payout).toEqual({ ok: false, reason: 'user-supplied-destination' });
    expect(policy.refusals()).toHaveLength(2);
  });
});
