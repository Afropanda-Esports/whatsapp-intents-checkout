import { describe, expect, it } from 'vitest';
import { createConversationService } from '../../src/domain/conversation/conversation-service.js';
import { createToolPolicy } from '../../src/domain/conversation/tool-policy.js';
import { createInMemoryConversationStore } from '../../src/fakes/in-memory-conversation-store.js';
import type { LanguageModel } from '../../src/ports/outbound/language-model.js';

describe('conversation service tool gate', () => {
  it('does not call checkout when the policy refuses the tool', async () => {
    let payments = 0;
    const policy = createToolPolicy();
    const model: LanguageModel = {
      async nextStep() {
        return {
          kind: 'tool',
          call: {
            name: 'create_payment',
            arguments: { destination: 'TAttackerAddr', amount: '1000000', sku: 'psn-10' },
          },
        };
      },
    };
    const service = createConversationService({
      model,
      policy,
      catalog: {
        async listCatalog() {
          throw new Error('catalog should not be called');
        },
      },
      orders: {
        async createOrder() {
          throw new Error('order should not be called');
        },
        async markFulfilled() {
          throw new Error('fulfil should not be called');
        },
        async readVoucher() {
          return 'VOUCHER-PSN-10';
        },
      },
      checkout: {
        async createPayment() {
          payments += 1;
          throw new Error('payment should not be called');
        },
        async readPayment() {
          throw new Error('read should not be called');
        },
        async markFulfilled() {
          throw new Error('mark should not be called');
        },
      },
      store: createInMemoryConversationStore(),
    });

    const outgoing = await service.handleMessage({ conversationId: 'c1', text: 'buy psn-10' });
    expect(payments).toBe(0);
    expect(outgoing.reply).toContain('cannot');
    expect(outgoing.reply).not.toContain('VOUCHER-PSN-10');
    expect(policy.refusals()).toEqual([
      { conversationId: 'c1', tool: 'create_payment', reason: 'user-supplied-destination:destination' },
    ]);
  });
});
