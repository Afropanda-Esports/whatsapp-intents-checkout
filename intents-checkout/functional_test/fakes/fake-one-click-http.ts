import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tokenFixture } from '../../unit_test/fixtures/tokens.js';
import { quoteResponseFixture } from '../../unit_test/fixtures/quotes.js';

export type FakeOneClick = {
  url: string;
  quoteBodies: Array<Record<string, unknown>>;
  /** Force the next quote responses to this HTTP status (null = normal). */
  setQuoteStatus(status: number | null): void;
  close(): Promise<void>;
};

/**
 * Local stand-in for the 1Click API: GET /v0/tokens and POST /v0/quote.
 * Quotes echo the requested amount and hand out a fresh deposit address each time.
 * Shared by functional tests and judge fake mode (slice 16).
 */
export async function startFakeOneClick(): Promise<FakeOneClick> {
  const quoteBodies: Array<Record<string, unknown>> = [];
  let forcedStatus: number | null = null;
  const server: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v0/tokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(tokenFixture));
      return;
    }
    if (request.method === 'POST' && request.url === '/v0/quote') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      request.on('end', () => {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        quoteBodies.push(parsed);
        if (forcedStatus !== null) {
          response.writeHead(forcedStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'forced by fake' }));
          return;
        }
        const body = quoteResponseFixture({
          amountOut: String(parsed['amount']),
          depositAddress: `TFakeDeposit${String(quoteBodies.length).padStart(8, '0')}`,
          deadline: String(parsed['deadline']),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    quoteBodies,
    setQuoteStatus(status) {
      forcedStatus = status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
