import type { StoredConversation } from '../domain/conversation/types.js';
import type { ConversationStore } from '../ports/outbound/conversation-store.js';

export function createInMemoryConversationStore(): ConversationStore {
  const rows = new Map<string, StoredConversation>();
  return {
    async load(conversationId) {
      const row = rows.get(conversationId);
      if (row === undefined) return undefined;
      return structuredClone(row);
    },
    async save(conversation) {
      rows.set(conversation.conversationId, structuredClone(conversation));
    },
  };
}
