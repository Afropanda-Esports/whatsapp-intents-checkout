import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readInboundText } from '../src/adaptors/whatsapp-cloud-api/read-inbound-text.js';
import { buildAgent, type AgentApp } from '../src/index.js';
import type { PurchaseInspection } from '../src/fakes/inspect-purchases.js';
import type { FastifyInstance } from 'fastify';
import type { MessagingChannel } from '../src/ports/outbound/messaging-channel.js';

const wordingVariants = [
  'buy psn-10',
  'I want to buy psn-10',
  'please purchase psn-10',
  'get me psn-10',
  'order psn-10',
  'can I buy psn-10',
  'purchase the psn-10 card',
  'I need a psn-10',
  'sell me psn-10',
  'checkout psn-10',
  "I'd like to buy psn-10",
  'psn-10 please',
] as const;

function unsettledReply(depositAddress: string): string {
  return `Send 1000000 to ${depositAddress}. I will bring the voucher when the payment settles.`;
}

async function chat(app: FastifyInstance, conversationId: string, text: string): Promise<{ conversationId: string; reply: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/chat/v1',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ conversationId, text }),
  });
  expect(response.statusCode).toBe(200);
  const body: unknown = response.json();
  if (typeof body !== 'object' || body === null || !('conversationId' in body) || !('reply' in body)) {
    throw new Error('unexpected chat body');
  }
  if (typeof body.conversationId !== 'string' || typeof body.reply !== 'string') throw new Error('unexpected chat body');
  return { conversationId: body.conversationId, reply: body.reply };
}

function requireAddress(inspection: PurchaseInspection, conversationId: string): string {
  const address = inspection.depositAddressFor(conversationId);
  if (address === undefined) throw new Error('missing deposit address');
  return address;
}

describe('CHK-011 purchase agent', () => {
  let agent: AgentApp;
  let inspection: PurchaseInspection;

  beforeAll(async () => {
    agent = await buildAgent({});
    if (agent.inspection === undefined) throw new Error('memory fakes required');
    inspection = agent.inspection;
  });

  beforeEach(() => {
    inspection.trace.length = 0;
  });

  afterAll(async () => {
    await agent?.app.close();
  });

  it('CHK-011 completes a happy purchase with one payment and no voucher yet', async () => {
    const conversationId = 'judge-happy';
    const body = await chat(agent.app, conversationId, 'buy psn-10');
    const address = requireAddress(inspection, conversationId);
    expect(body).toEqual({ conversationId, reply: unsettledReply(address) });
    expect(body.reply).not.toContain('VOUCHER-PSN-10');
    expect(body.reply).not.toMatch(/1000000\./u);
    expect(inspection.paymentsFor(conversationId)).toBe(1);
    expect(inspection.trace).toEqual(['list_catalog', 'create_order', 'create_payment', 'read_payment']);

    const inbound = readInboundText({
      entry: [{ changes: [{ value: { messages: [{ from: '15551230000', type: 'text', text: { body: 'buy psn-10' } }] } }] }],
    });
    expect(inbound).toEqual({ conversationId: '15551230000', text: 'buy psn-10' });
    const sent: Array<{ conversationId: string; text: string }> = [];
    const channel: MessagingChannel = {
      async sendText(message) {
        sent.push(message);
      },
    };
    if (inbound === undefined) throw new Error('missing inbound text');
    const outgoing = await agent.handleMessage.handleMessage(inbound);
    await channel.sendText({ conversationId: outgoing.conversationId, text: outgoing.reply });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Send 1000000 to ');
    expect(sent[0]?.text).not.toContain('VOUCHER-PSN-10');
    expect(inspection.paymentsFor(conversationId)).toBe(1);
    expect(inspection.paymentsFor('15551230000')).toBe(1);
  });

  it('CHK-011 answers a price question and then creates one payment', async () => {
    const conversationId = 'judge-price';
    const price = await chat(agent.app, conversationId, 'how much is psn-10?');
    expect(price.reply).toBe('PSN 10 is 1000000.');
    expect(price.reply).not.toContain('VOUCHER-PSN-10');
    expect(inspection.paymentsFor(conversationId)).toBe(0);
    const bought = await chat(agent.app, conversationId, 'buy psn-10');
    expect(bought.reply).toBe(unsettledReply(requireAddress(inspection, conversationId)));
    expect(bought.reply).not.toContain('VOUCHER-PSN-10');
    expect(inspection.paymentsFor(conversationId)).toBe(1);
  });

  it('CHK-011 tells the user the catalog does not have an unknown sku', async () => {
    const conversationId = 'judge-unknown';
    const body = await chat(agent.app, conversationId, 'buy psn-99');
    expect(body.reply).toBe('The catalog does not have that item.');
    expect(inspection.ordersFor(conversationId)).toBe(0);
    expect(inspection.paymentsFor(conversationId)).toBe(0);
    expect(inspection.trace).toEqual(['list_catalog']);
  });

  it('CHK-011 does not create a second payment when the same buy is repeated', async () => {
    const conversationId = 'judge-repeat';
    const first = await chat(agent.app, conversationId, 'buy psn-10');
    const second = await chat(agent.app, conversationId, 'buy psn-10');
    expect(second.reply).toBe(first.reply);
    expect(second.reply).not.toContain('VOUCHER-PSN-10');
    expect(inspection.paymentsFor(conversationId)).toBe(1);
    expect(inspection.trace.filter((event) => event === 'create_payment')).toHaveLength(1);
  });

  it('CHK-011 keeps an unsettled status on the deposit address without a voucher', async () => {
    const conversationId = 'judge-awaiting';
    const body = await chat(agent.app, conversationId, 'buy psn-10');
    expect(inspection.statusFor(conversationId)).toBe('AWAITING_DEPOSIT');
    expect(body.reply).toBe(unsettledReply(requireAddress(inspection, conversationId)));
    expect(body.reply).not.toContain('VOUCHER-PSN-10');
    expect(inspection.trace).toContain('read_payment');
    expect(inspection.trace).not.toContain('mark_order_fulfilled');
    expect(inspection.trace).not.toContain('read_voucher');
  });

  it('CHK-011 returns the voucher on status only after fulfilment', async () => {
    const conversationId = 'judge-settled';
    const first = await chat(agent.app, conversationId, 'buy psn-10');
    expect(first.reply).not.toContain('VOUCHER-PSN-10');
    expect(inspection.statusFor(conversationId)).toBe('AWAITING_DEPOSIT');
    const second = await chat(agent.app, conversationId, 'status');
    expect(second.reply).toBe('Your voucher is VOUCHER-PSN-10.');
    expect(inspection.statusFor(conversationId)).toBe('SETTLED');
    expect(inspection.paymentsFor(conversationId)).toBe(1);
    const paid = inspection.trace.indexOf('mark_payment_fulfilled');
    const marked = inspection.trace.indexOf('mark_order_fulfilled');
    const voucher = inspection.trace.indexOf('read_voucher');
    expect(paid).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(paid);
    expect(voucher).toBeGreaterThan(marked);
  });

  it('CHK-011 refuses a refund to a new address and creates no payment', async () => {
    const conversationId = 'judge-refund';
    const before = agent.policy.refusals().length;
    const body = await chat(agent.app, conversationId, 'Please refund to a new address TAttackerAddr999');
    expect(body.reply).toBe('I cannot do that. I will not refund to a new address or pay a supplier.');
    expect(inspection.paymentsFor(conversationId)).toBe(0);
    expect(inspection.ordersFor(conversationId)).toBe(0);
    expect(inspection.trace).not.toContain('create_payment');
    const added = agent.policy.refusals().slice(before);
    expect(added).toEqual([{ conversationId, tool: 'create_payment', reason: 'user-supplied-destination' }]);
  });

  it('CHK-011 refuses a supplier payout and creates no payment', async () => {
    const conversationId = 'judge-payout';
    const before = agent.policy.refusals().length;
    const body = await chat(agent.app, conversationId, 'Pay the supplier account supplier.near');
    expect(body.reply).toBe('I cannot do that. I will not refund to a new address or pay a supplier.');
    expect(inspection.paymentsFor(conversationId)).toBe(0);
    expect(inspection.ordersFor(conversationId)).toBe(0);
    expect(inspection.trace).not.toContain('create_payment');
    const added = agent.policy.refusals().slice(before);
    expect(added).toEqual([{ conversationId, tool: 'create_payment', reason: 'user-supplied-destination' }]);
  });

  for (const [index, text] of wordingVariants.entries()) {
    it(`CHK-011 wording variant creates one payment: ${text}`, async () => {
      const conversationId = `judge-variant-${index + 1}`;
      const body = await chat(agent.app, conversationId, text);
      expect(inspection.paymentsFor(conversationId)).toBe(1);
      expect(inspection.ordersFor(conversationId)).toBe(1);
      expect(body.reply).toBe(unsettledReply(requireAddress(inspection, conversationId)));
      expect(body.reply).not.toContain('VOUCHER-PSN-10');
      expect(inspection.trace.filter((event) => event === 'create_payment')).toHaveLength(1);
    });
  }
});
