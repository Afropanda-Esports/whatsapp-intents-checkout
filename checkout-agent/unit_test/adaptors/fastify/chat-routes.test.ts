import { describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/adaptors/fastify/server.js';

describe('POST /chat/v1', () => {
  it('returns the reply without an API key', async () => {
    const app = await buildServer({
      handleMessage: {
        async handleMessage(input) {
          return { conversationId: input.conversationId, reply: 'ok' };
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/chat/v1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ conversationId: 'judge-1', text: 'a'.repeat(500) }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ conversationId: 'judge-1', reply: 'ok' });
    await app.close();
  });

  it('returns a problem body for malformed JSON and an over-long text', async () => {
    const app = await buildServer({
      handleMessage: {
        async handleMessage() {
          throw new Error('handler should not run');
        },
      },
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/chat/v1',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    expect(malformed.body).not.toMatch(/Unexpected|FST_|Expected property/u);
    expect(malformed.json()).toMatchObject({
      status: 400,
      title: 'Invalid request',
      errors: [{ path: 'body', message: 'body must be valid JSON' }],
    });
    expect(malformed.json()).not.toHaveProperty('message');
    expect(malformed.json()).not.toHaveProperty('error');

    const tooLong = await app.inject({
      method: 'POST',
      url: '/chat/v1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ conversationId: 'judge-1', text: 'a'.repeat(501) }),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.headers['content-type']).toContain('application/problem+json');
    const body = tooLong.json<{ errors: Array<{ path: string }> }>();
    expect(body.errors[0]?.path).toBe('text');
    expect(tooLong.body).not.toMatch(/FST_/u);

    await app.close();
  });
});
