import type { FastifyInstance } from 'fastify';
import type { HandleMessage } from '../../ports/inbound/handle-message.js';
import type { MessagingChannel } from '../../ports/outbound/messaging-channel.js';

export type InboundText = {
  conversationId: string;
  text: string;
};

export type WhatsAppRouteDeps = {
  handleMessage: HandleMessage;
  channel: MessagingChannel;
  readInboundText: (payload: unknown) => InboundText | undefined;
};

/** Translates one Cloud API payload through the conversation service. No merchant key. */
export function registerWhatsAppWebhook(app: FastifyInstance, deps: WhatsAppRouteDeps): void {
  app.post('/whatsapp/webhook', async (request, reply) => {
    const inbound = deps.readInboundText(request.body);
    if (inbound === undefined) return reply.code(200).send({ received: true });
    const outgoing = await deps.handleMessage.handleMessage(inbound);
    await deps.channel.sendText({ conversationId: outgoing.conversationId, text: outgoing.reply });
    return reply.code(200).send({ received: true });
  });
}
