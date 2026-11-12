import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { quoteResponseFixture } from './quotes.js';
import { tokenFixture } from './tokens.js';

export type FakeOneClickOptions = {
  /** When the status queue is empty, SUCCESS for a deposit address this server quoted. */
  settleQuotedDeposits?: boolean;
};

export type FakeOneClick = {
  url: string;
  quoteBodies: Array<Record<string, unknown>>;
  /** Force the next quote responses to this HTTP status (null = normal). */
  setQuoteStatus(status: number | null): void;
  /** Next GET /v0/status body. A number is the HTTP status instead of a JSON body. */
  pushStatus(body: unknown | number): void;
  /** The next quote echoes this recipient instead of the one in the request. */
  setQuoteRecipient(recipient: string | null): void;
  statusReads: { count: number };
  close(): Promise<void>;
};

/**
 * Local stand-in for the 1Click API: GET /v0/tokens, POST /v0/quote, and GET /v0/status.
 * Quotes echo the requested amount and hand out a fresh deposit address each time.
 * Shared by functional tests and fake mode.
 */
export async function startFakeOneClick(options?: FakeOneClickOptions): Promise<FakeOneClick> {
  const settleQuotedDeposits = options?.settleQuotedDeposits === true;
  const series = randomBytes(4).toString('hex');
  const quoteBodies: Array<Record<string, unknown>> = [];
  const quotedAmounts = new Map<string, string>();
  const statusQueue: Array<unknown | number> = [];
  const statusReads = { count: 0 };
  let forcedStatus: number | null = null;
  let recipientOverride: string | null = null;
  const server: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v0/status') === true) {
      statusReads.count += 1;
      const next = statusQueue.shift();
      if (typeof next === 'number') {
        response.writeHead(next);
        response.end();
        return;
      }
      if (next === undefined) {
        const settled = settleQuotedDeposits ? settledBody(request.url, quotedAmounts) : undefined;
        if (settled !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(settled));
          return;
        }
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(next));
      return;
    }
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
        const depositAddress = `TFakeDeposit${series}${String(quoteBodies.length).padStart(8, '0')}`;
        const amountOut = typeof parsed['amount'] === 'string' ? parsed['amount'] : String(parsed['amount']);
        quotedAmounts.set(depositAddress, amountOut);
        if (forcedStatus !== null) {
          response.writeHead(forcedStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'forced by fake' }));
          return;
        }
        const body = quoteResponseFixture({
          amountOut,
          depositAddress,
          deadline: String(parsed['deadline']),
        });
        const quoteRequest = body['quoteRequest'];
        const recipient = recipientOverride ?? parsed['recipient'];
        recipientOverride = null;
        if (typeof recipient === 'string' && typeof quoteRequest === 'object' && quoteRequest !== null) {
          (quoteRequest as Record<string, unknown>)['recipient'] = recipient;
        }
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
    pushStatus(body) {
      statusQueue.push(body);
    },
    setQuoteRecipient(recipient) {
      recipientOverride = recipient;
    },
    statusReads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function depositAddressOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const query = url.split('?')[1];
  if (query === undefined) return undefined;
  return new URLSearchParams(query).get('depositAddress') ?? undefined;
}

/** Status body for a quoted deposit. Amount stays the base-unit string from the quote. */
function settledBody(url: string | undefined, quotedAmounts: Map<string, string>): Record<string, unknown> | undefined {
  const depositAddress = depositAddressOf(url);
  if (depositAddress === undefined) return undefined;
  const amountOut = quotedAmounts.get(depositAddress);
  if (amountOut === undefined) return undefined;
  return {
    correlationId: 'fake-settled',
    status: 'SUCCESS',
    updatedAt: '2026-11-12T00:00:00.000Z',
    swapDetails: {
      amountOut,
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: 'origin-hash', explorerUrl: 'https://example.invalid/tx/origin-hash' }],
      destinationChainTxHashes: [{ hash: 'near-hash', explorerUrl: 'https://example.invalid/tx/near-hash' }],
    },
  };
}
