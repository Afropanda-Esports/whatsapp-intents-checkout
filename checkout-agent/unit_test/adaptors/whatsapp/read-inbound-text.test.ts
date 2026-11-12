import { describe, expect, it } from 'vitest';
import { readInboundText } from '../../../src/adaptors/whatsapp-cloud-api/read-inbound-text.js';

describe('WhatsApp Cloud API translator', () => {
  it('reads a text message and ignores other message types', () => {
    const text = readInboundText({
      entry: [{ changes: [{ value: { messages: [{ from: '15551230000', type: 'text', text: { body: 'buy psn-10' } }] } }] }],
    });
    expect(text).toEqual({ conversationId: '15551230000', text: 'buy psn-10' });
    const image = readInboundText({
      entry: [{ changes: [{ value: { messages: [{ from: '15551230000', type: 'image' }] } }] }],
    });
    expect(image).toBeUndefined();
  });
});
