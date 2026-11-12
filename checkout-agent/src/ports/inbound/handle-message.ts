export type IncomingMessage = {
  conversationId: string;
  text: string;
};

export type OutgoingMessage = {
  conversationId: string;
  reply: string;
};

export type HandleMessage = {
  handleMessage(input: IncomingMessage): Promise<OutgoingMessage>;
};
