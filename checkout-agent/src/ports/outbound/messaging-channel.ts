export type OutboundText = {
  conversationId: string;
  text: string;
};

export type MessagingChannel = {
  sendText(input: OutboundText): Promise<void>;
};
