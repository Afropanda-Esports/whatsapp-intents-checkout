import Fastify, { type FastifyInstance } from 'fastify';
import type { HandleMessage } from '../../ports/inbound/handle-message.js';
import { problemDocument, zodIssues } from './problem.js';
import { chatRequestBody } from './schema-chat.js';

export type ChatServerDeps = {
  handleMessage: HandleMessage;
};

export async function buildServer(deps: ChatServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode;
    const status = statusCode !== undefined && statusCode >= 400 && statusCode < 500 ? 400 : 500;
    const body =
      status === 400
        ? problemDocument(400, 'Invalid request', '/problems/invalid-request', {
            errors: [{ path: 'body', message: 'body must be valid JSON' }],
          })
        : problemDocument(500, 'Internal error', '/problems/internal', {});
    return reply.code(status).type('application/problem+json').send(body);
  });

  app.post('/chat/v1', async (request, reply) => {
    const parsed = chatRequestBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .type('application/problem+json')
        .send(
          problemDocument(400, 'Invalid request', '/problems/invalid-request', {
            errors: zodIssues(parsed.error.issues),
          }),
        );
    }
    const outgoing = await deps.handleMessage.handleMessage(parsed.data);
    return reply.code(200).type('application/json').send({
      conversationId: outgoing.conversationId,
      reply: outgoing.reply,
    });
  });

  return app;
}
