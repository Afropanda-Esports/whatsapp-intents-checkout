import type { MessagingChannel } from '../../ports/outbound/messaging-channel.js';

export type CloudApiChannelOptions = {
  phoneNumberId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
};

export function createCloudApiMessagingChannel(options: CloudApiChannelOptions): MessagingChannel {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async sendText(message) {
      await fetchImpl(new URL(`https://graph.facebook.com/v20.0/${options.phoneNumberId}/messages`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: message.conversationId,
          type: 'text',
          text: { body: message.text },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    },
  };
}
