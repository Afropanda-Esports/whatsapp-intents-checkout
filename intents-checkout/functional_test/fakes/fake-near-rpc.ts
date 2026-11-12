import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { baseEncode } from 'near-api-js';

export type RecordedCall = {
  methodName: string;
  args: unknown;
};

export type FakeNearRpc = {
  url: string;
  calls: RecordedCall[];
  /** The next broadcast returns a failed transaction whose panic text contains `code`. */
  failNext(code: string, txHash: string): void;
  close(): Promise<void>;
};

const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(1));

/**
 * JSON-RPC stand-in for the two calls near-api-js makes for one function call:
 * `query` (view_access_key) and `send_tx`.
 */
export async function startFakeNearRpc(): Promise<FakeNearRpc> {
  const calls: RecordedCall[] = [];
  const failures: Array<{ code: string; txHash: string }> = [];
  let nonce = 1;
  let successCount = 0;
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: { id?: unknown; method?: unknown; params?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: unknown; params?: unknown };
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const id = body.id ?? '1';
      if (body.method === 'query') {
        nonce += 1;
        write(response, id, {
          nonce,
          block_hash: BLOCK_HASH,
          block_height: 1,
          permission: 'FullAccess',
        });
        return;
      }
      if (body.method === 'send_tx') {
        const params = isRecord(body.params) ? body.params : {};
        const raw = typeof params['signed_tx_base64'] === 'string' ? params['signed_tx_base64'] : '';
        const recorded = raw.length === 0 ? undefined : functionCallFrom(Buffer.from(raw, 'base64'));
        if (recorded !== undefined) calls.push(recorded);
        const failure = failures.shift();
        if (failure !== undefined) {
          write(response, id, {
            status: {
              Failure: {
                ActionError: {
                  kind: {
                    FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure.code}` },
                  },
                },
              },
            },
            transaction: { hash: failure.txHash },
          });
          return;
        }
        successCount += 1;
        write(response, id, {
          status: { SuccessValue: '' },
          transaction: { hash: `FakeTxSuccess${String(successCount)}` },
        });
        return;
      }
      writeError(response, id, `unexpected method ${String(body.method)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    failNext(code, txHash) {
      failures.push({ code, txHash });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function write(response: ServerResponse, id: unknown, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function writeError(response: ServerResponse, id: unknown, message: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }));
}

/** Borsh function-call args are a length-prefixed method name followed by length-prefixed JSON bytes. */
function functionCallFrom(bytes: Buffer): RecordedCall | undefined {
  for (const methodName of ['register_payment', 'mark_fulfilled']) {
    const needle = Buffer.from(methodName);
    let from = 0;
    while (from < bytes.length) {
      const at = bytes.indexOf(needle, from);
      if (at < 4) break;
      if (bytes.readUInt32LE(at - 4) === methodName.length) {
        const argsAt = at + methodName.length;
        if (argsAt + 4 <= bytes.length) {
          const argsLen = bytes.readUInt32LE(argsAt);
          const start = argsAt + 4;
          const end = start + argsLen;
          if (argsLen > 0 && end <= bytes.length) {
            try {
              return { methodName, args: JSON.parse(bytes.subarray(start, end).toString('utf8')) as unknown };
            } catch {
              return undefined;
            }
          }
        }
      }
      from = at + 1;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
