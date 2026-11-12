export const TOOL_NAMES = [
  'list_catalog',
  'create_order',
  'create_payment',
  'read_payment',
  'mark_fulfilled',
  'read_voucher',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolCall = {
  name: ToolName;
  arguments: Readonly<Record<string, string>>;
};

export type ToolResult = {
  name: ToolName;
  output: Readonly<Record<string, string>>;
};

export type ModelStep = { kind: 'tool'; call: ToolCall } | { kind: 'reply' };

/** Ids the service already chose. The model does not invent a destination. */
export type ModelKnown = {
  orderId?: string;
  paymentId?: string;
  sku?: string;
  amount?: string;
};

export type CatalogItem = {
  sku: string;
  name: string;
  price: string;
};

export type MerchantOrder = {
  id: string;
  sku: string;
  conversationId: string;
};

export type CheckoutPayment = {
  id: string;
  orderId: string;
  amount: string;
  depositAddress: string;
  status: string;
};

export type StoredTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export type StoredConversation = {
  conversationId: string;
  turns: readonly StoredTurn[];
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
