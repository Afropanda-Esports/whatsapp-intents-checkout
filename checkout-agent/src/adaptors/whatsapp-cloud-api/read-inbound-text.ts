export type InboundText = {
  conversationId: string;
  text: string;
};

/** Reads the first Cloud API text message. Anything else is ignored. */
export function readInboundText(payload: unknown): InboundText | undefined {
  if (typeof payload !== 'object' || payload === null || !('entry' in payload)) return undefined;
  const { entry } = payload;
  if (!Array.isArray(entry)) return undefined;
  for (const item of entry) {
    const text = textFromEntry(item);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textFromEntry(item: unknown): InboundText | undefined {
  if (typeof item !== 'object' || item === null || !('changes' in item) || !Array.isArray(item.changes)) return undefined;
  for (const change of item.changes) {
    const text = textFromChange(change);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textFromChange(change: unknown): InboundText | undefined {
  if (typeof change !== 'object' || change === null || !('value' in change)) return undefined;
  const { value } = change;
  if (typeof value !== 'object' || value === null || !('messages' in value) || !Array.isArray(value.messages)) return undefined;
  for (const message of value.messages) {
    const text = textFromMessage(message);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textFromMessage(message: unknown): InboundText | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('from' in message) || typeof message.from !== 'string') return undefined;
  if (!('type' in message) || message.type !== 'text') return undefined;
  if (!('text' in message) || typeof message.text !== 'object' || message.text === null) return undefined;
  if (!('body' in message.text) || typeof message.text.body !== 'string') return undefined;
  const conversationId = message.from;
  const text = message.text.body;
  if (conversationId.length < 1 || conversationId.length > 80) return undefined;
  if (text.length < 1 || text.length > 500) return undefined;
  return { conversationId, text };
}
