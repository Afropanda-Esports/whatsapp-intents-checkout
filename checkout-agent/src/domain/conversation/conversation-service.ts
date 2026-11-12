import { isBaseUnits } from './base-units.js';
import { encodeCatalog } from './catalog-codec.js';
import { classifyMessage, normalizeUtterance } from './classify-message.js';
import type { ToolPolicy } from './tool-policy.js';
import type { CatalogItem, ModelKnown, StoredConversation, ToolCall, ToolName, ToolResult } from './types.js';
import type { HandleMessage, OutgoingMessage } from '../../ports/inbound/handle-message.js';
import type { CheckoutPayments } from '../../ports/outbound/checkout-payments.js';
import type { ConversationStore } from '../../ports/outbound/conversation-store.js';
import type { LanguageModel } from '../../ports/outbound/language-model.js';
import type { MerchantCatalog } from '../../ports/outbound/merchant-catalog.js';
import type { MerchantOrders } from '../../ports/outbound/merchant-orders.js';

const REFUSAL_REPLY = 'I cannot do that. I will not refund to a new address or pay a supplier.';
const UNKNOWN_SKU_REPLY = 'The catalog does not have that item.';
const NO_PAYMENT_REPLY = 'There is no payment for this conversation yet.';
const FALLBACK_REPLY = 'Tell me which catalog item you want to buy.';
const MAX_STEPS = 8;

export type ConversationServiceDeps = {
  model: LanguageModel;
  policy: ToolPolicy;
  catalog: MerchantCatalog;
  orders: MerchantOrders;
  checkout: CheckoutPayments;
  store: ConversationStore;
};

type State = {
  conversationId: string;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  catalog: CatalogItem[];
  catalogListed: boolean;
  fulfilled: boolean;
  orderId?: string;
  paymentId?: string;
  sku?: string;
  amount?: string;
  depositAddress?: string;
  purchaseText?: string;
  status?: string;
  voucher?: string;
};

export function createConversationService(deps: ConversationServiceDeps): HandleMessage {
  return {
    async handleMessage(input) {
      const normalized = normalizeUtterance(input.text);
      const state = fromStored(await deps.store.load(input.conversationId), input.conversationId);
      const repeated = repeatedPurchaseReply(state, normalized);
      if (repeated !== undefined) return finish(deps.store, state, input.text, repeated);

      const toolResults: ToolResult[] = [];
      let refused = false;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const next = await deps.model.nextStep({
          conversationId: input.conversationId,
          text: input.text,
          toolResults,
          known: knownFrom(state),
        });
        if (next.kind === 'reply') break;
        const decision = deps.policy.assess({
          conversationId: input.conversationId,
          call: next.call,
          userText: input.text,
        });
        if (!decision.ok) {
          refused = true;
          break;
        }
        const executed = await executeTool(deps, state, next.call, normalized);
        if (executed === 'stop') break;
        toolResults.push(executed);
      }

      return finish(deps.store, state, input.text, composeReply(state, input.text, refused));
    },
  };
}

export function depositReply(amount: string, depositAddress: string): string {
  return `Send ${amount} to ${depositAddress}. I will bring the voucher when the payment settles.`;
}

export function voucherReply(code: string): string {
  return `Your voucher is ${code}.`;
}

function repeatedPurchaseReply(state: State, normalized: string): string | undefined {
  if (state.purchaseText !== normalized || state.paymentId === undefined) return undefined;
  if (state.fulfilled && state.voucher !== undefined && state.voucher.length > 0) return voucherReply(state.voucher);
  if (state.depositAddress !== undefined && state.amount !== undefined && !state.fulfilled) {
    return depositReply(state.amount, state.depositAddress);
  }
  return undefined;
}

function composeReply(state: State, text: string, refused: boolean): string {
  if (refused) return REFUSAL_REPLY;
  if (state.fulfilled && state.voucher !== undefined && state.voucher.length > 0) return voucherReply(state.voucher);
  const intent = classifyMessage(text);
  if ((intent.kind === 'buy' || intent.kind === 'price') && state.catalogListed) {
    const item = state.catalog.find((row) => row.sku === intent.sku);
    if (item === undefined) return UNKNOWN_SKU_REPLY;
    if (intent.kind === 'price') return `${item.name} is ${item.price}.`;
  }
  if (state.depositAddress !== undefined && state.amount !== undefined && state.status !== 'SETTLED' && !state.fulfilled) {
    return depositReply(state.amount, state.depositAddress);
  }
  if (intent.kind === 'status' && state.paymentId === undefined) return NO_PAYMENT_REPLY;
  return FALLBACK_REPLY;
}

async function executeTool(
  deps: ConversationServiceDeps,
  state: State,
  call: ToolCall,
  normalized: string,
): Promise<ToolResult | 'stop'> {
  switch (call.name) {
    case 'list_catalog':
      return listCatalog(deps, state);
    case 'create_order':
      return createOrder(deps, state, call);
    case 'create_payment':
      return createPayment(deps, state, normalized);
    case 'read_payment':
      return readPayment(deps, state);
    case 'mark_fulfilled':
      return markFulfilled(deps, state);
    case 'read_voucher':
      return readVoucher(deps, state);
    default:
      return 'stop';
  }
}

async function listCatalog(deps: ConversationServiceDeps, state: State): Promise<ToolResult> {
  const items = await deps.catalog.listCatalog();
  state.catalog = items.map((item) => ({ sku: item.sku, name: item.name, price: item.price }));
  state.catalogListed = true;
  return result('list_catalog', { items: encodeCatalog(state.catalog) });
}

async function createOrder(
  deps: ConversationServiceDeps,
  state: State,
  call: ToolCall,
): Promise<ToolResult | 'stop'> {
  if (state.orderId !== undefined && state.sku !== undefined) {
    return result('create_order', { orderId: state.orderId, sku: state.sku });
  }
  const sku = call.arguments['sku'];
  const item = sku === undefined ? undefined : state.catalog.find((row) => row.sku === sku);
  if (item === undefined || !isBaseUnits(item.price)) return 'stop';
  const order = await deps.orders.createOrder({ sku: item.sku, conversationId: state.conversationId });
  state.orderId = order.id;
  state.sku = item.sku;
  state.amount = item.price;
  return result('create_order', { orderId: order.id, sku: item.sku });
}

async function createPayment(
  deps: ConversationServiceDeps,
  state: State,
  normalized: string,
): Promise<ToolResult | 'stop'> {
  if (state.orderId === undefined || state.amount === undefined || !isBaseUnits(state.amount)) return 'stop';
  if (state.paymentId !== undefined && state.depositAddress !== undefined) {
    return result('create_payment', {
      paymentId: state.paymentId,
      amount: state.amount,
      depositAddress: state.depositAddress,
      status: state.status ?? 'AWAITING_DEPOSIT',
    });
  }
  const payment = await deps.checkout.createPayment({ orderId: state.orderId, amount: state.amount });
  if (!isBaseUnits(payment.amount)) return 'stop';
  state.paymentId = payment.id;
  state.depositAddress = payment.depositAddress;
  state.amount = payment.amount;
  state.status = payment.status;
  state.purchaseText = normalized;
  return result('create_payment', {
    paymentId: payment.id,
    amount: payment.amount,
    depositAddress: payment.depositAddress,
    status: payment.status,
  });
}

async function readPayment(deps: ConversationServiceDeps, state: State): Promise<ToolResult | 'stop'> {
  if (state.paymentId === undefined) return 'stop';
  const payment = await deps.checkout.readPayment(state.paymentId);
  if (!isBaseUnits(payment.amount)) return 'stop';
  state.status = payment.status;
  state.depositAddress = payment.depositAddress;
  state.amount = payment.amount;
  return result('read_payment', {
    paymentId: payment.id,
    amount: payment.amount,
    depositAddress: payment.depositAddress,
    status: payment.status,
  });
}

async function markFulfilled(deps: ConversationServiceDeps, state: State): Promise<ToolResult | 'stop'> {
  if (state.paymentId === undefined || state.orderId === undefined) return 'stop';
  if (state.status !== 'SETTLED') return 'stop';
  await deps.checkout.markFulfilled(state.paymentId);
  await deps.orders.markFulfilled(state.orderId);
  state.fulfilled = true;
  return result('mark_fulfilled', { fulfilled: 'yes' });
}

async function readVoucher(deps: ConversationServiceDeps, state: State): Promise<ToolResult | 'stop'> {
  if (!state.fulfilled || state.orderId === undefined) return 'stop';
  const code = await deps.orders.readVoucher(state.orderId);
  if (code !== null && code.length > 0) state.voucher = code;
  return result('read_voucher', { voucher: state.voucher ?? '' });
}

function result(name: ToolName, output: Record<string, string>): ToolResult {
  return { name, output };
}

function knownFrom(state: State): ModelKnown {
  const known: ModelKnown = {};
  if (state.orderId !== undefined) known.orderId = state.orderId;
  if (state.paymentId !== undefined) known.paymentId = state.paymentId;
  if (state.sku !== undefined) known.sku = state.sku;
  if (state.amount !== undefined) known.amount = state.amount;
  return known;
}

async function finish(
  store: ConversationStore,
  state: State,
  userText: string,
  reply: string,
): Promise<OutgoingMessage> {
  state.turns.push({ role: 'user', text: userText }, { role: 'assistant', text: reply });
  await store.save(toStored(state));
  return { conversationId: state.conversationId, reply };
}

function fromStored(stored: StoredConversation | undefined, conversationId: string): State {
  const state: State = {
    conversationId,
    turns: stored === undefined ? [] : stored.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    catalog: [],
    catalogListed: false,
    fulfilled: stored?.fulfilled ?? false,
  };
  if (stored === undefined) return state;
  if (stored.orderId !== undefined) state.orderId = stored.orderId;
  if (stored.paymentId !== undefined) state.paymentId = stored.paymentId;
  if (stored.sku !== undefined) state.sku = stored.sku;
  if (stored.amount !== undefined) state.amount = stored.amount;
  if (stored.depositAddress !== undefined) state.depositAddress = stored.depositAddress;
  if (stored.purchaseText !== undefined) state.purchaseText = stored.purchaseText;
  if (stored.status !== undefined) state.status = stored.status;
  if (stored.voucher !== undefined) state.voucher = stored.voucher;
  return state;
}

function toStored(state: State): StoredConversation {
  const stored: StoredConversation = {
    conversationId: state.conversationId,
    turns: state.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    fulfilled: state.fulfilled,
  };
  if (state.orderId !== undefined) stored.orderId = state.orderId;
  if (state.paymentId !== undefined) stored.paymentId = state.paymentId;
  if (state.sku !== undefined) stored.sku = state.sku;
  if (state.amount !== undefined) stored.amount = state.amount;
  if (state.depositAddress !== undefined) stored.depositAddress = state.depositAddress;
  if (state.purchaseText !== undefined) stored.purchaseText = state.purchaseText;
  if (state.status !== undefined) stored.status = state.status;
  if (state.voucher !== undefined) stored.voucher = state.voucher;
  return stored;
}
