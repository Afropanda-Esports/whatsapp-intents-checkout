import type { StoredConversation } from '../../domain/conversation/types.js';

export type ConversationStore = {
  load(conversationId: string): Promise<StoredConversation | undefined>;
  save(conversation: StoredConversation): Promise<void>;
};
