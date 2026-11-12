import { decodeCatalog } from '../../domain/conversation/catalog-codec.js';
import { classifyMessage } from '../../domain/conversation/classify-message.js';
import type { ToolCall, ToolName, ToolResult } from '../../domain/conversation/types.js';
import type { LanguageModel, ModelRequest } from '../../ports/outbound/language-model.js';

/** Test double. A buy message emits catalog, order, payment, status, then fulfilment only after settlement. */
export function createScriptedLanguageModel(): LanguageModel {
  return {
    async nextStep(request) {
      const intent = classifyMessage(request.text);
      const done = new Set(request.toolResults.map((result) => result.name));
      if (intent.kind === 'refund') return refundStep(done, intent.address);
      if (intent.kind === 'payout') return payoutStep(done, intent.account);
      if (intent.kind === 'price' || intent.kind === 'buy') return purchaseStep(request, done, intent);
      if (intent.kind === 'status') return statusStep(request, done);
      return { kind: 'reply' };
    },
  };
}

function refundStep(done: ReadonlySet<ToolName>, address: string): { kind: 'tool'; call: ToolCall } | { kind: 'reply' } {
  if (done.has('create_payment')) return { kind: 'reply' };
  return { kind: 'tool', call: { name: 'create_payment', arguments: { refundAddress: address, destination: address } } };
}

function payoutStep(done: ReadonlySet<ToolName>, account: string): { kind: 'tool'; call: ToolCall } | { kind: 'reply' } {
  if (done.has('create_payment')) return { kind: 'reply' };
  return {
    kind: 'tool',
    call: { name: 'create_payment', arguments: { payee: 'supplier', accountId: account, destination: account } },
  };
}

function purchaseStep(
  request: ModelRequest,
  done: ReadonlySet<ToolName>,
  intent: { kind: 'buy' | 'price'; sku: string },
): { kind: 'tool'; call: ToolCall } | { kind: 'reply' } {
  if (!done.has('list_catalog')) return tool('list_catalog', {});
  const items = decodeCatalog(outputOf(request.toolResults, 'list_catalog')?.['items']);
  const item = items.find((row) => row.sku === intent.sku);
  if (item === undefined || intent.kind === 'price') return { kind: 'reply' };
  if (!done.has('create_order')) return tool('create_order', { sku: item.sku });
  const orderId = outputOf(request.toolResults, 'create_order')?.['orderId'];
  if (orderId === undefined) return { kind: 'reply' };
  if (!done.has('create_payment')) return tool('create_payment', { sku: item.sku, amount: item.price, orderId });
  const paymentId = outputOf(request.toolResults, 'create_payment')?.['paymentId'];
  if (paymentId === undefined) return { kind: 'reply' };
  if (!done.has('read_payment')) return tool('read_payment', { paymentId });
  if (outputOf(request.toolResults, 'read_payment')?.['status'] !== 'SETTLED') return { kind: 'reply' };
  if (!done.has('mark_fulfilled')) return tool('mark_fulfilled', { paymentId, orderId });
  if (!done.has('read_voucher')) return tool('read_voucher', { orderId });
  return { kind: 'reply' };
}

function statusStep(request: ModelRequest, done: ReadonlySet<ToolName>): { kind: 'tool'; call: ToolCall } | { kind: 'reply' } {
  const paymentId = request.known.paymentId;
  const orderId = request.known.orderId;
  if (paymentId === undefined || orderId === undefined) return { kind: 'reply' };
  if (!done.has('read_payment')) return tool('read_payment', { paymentId });
  if (outputOf(request.toolResults, 'read_payment')?.['status'] !== 'SETTLED') return { kind: 'reply' };
  if (!done.has('mark_fulfilled')) return tool('mark_fulfilled', { paymentId, orderId });
  if (!done.has('read_voucher')) return tool('read_voucher', { orderId });
  return { kind: 'reply' };
}

function tool(name: ToolName, args: Record<string, string>): { kind: 'tool'; call: ToolCall } {
  return { kind: 'tool', call: { name, arguments: args } };
}

function outputOf(results: readonly ToolResult[], name: ToolName): Readonly<Record<string, string>> | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (result !== undefined && result.name === name) return result.output;
  }
  return undefined;
}
