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
  /** The next `request_refund` succeeds as Escalated. */
  escalateNext(): void;
  /** The next `storage_balance_of` says the account is not registered. */
  unregisteredNext(): void;
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
  const requests: Array<{ id: string; status: string; executed: boolean }> = [];
  let nonce = 1;
  let successCount = 0;
  let escalate = false;
  let unregistered = false;
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
        const params = isRecord(body.params) ? body.params : {};
        if (params['request_type'] === 'call_function') {
          const methodName = typeof params['method_name'] === 'string' ? params['method_name'] : '';
          const args = argsFromBase64(params['args_base64']);
          calls.push({ methodName, args });
          write(response, id, {
            result: Array.from(Buffer.from(JSON.stringify(viewResult(methodName, args)))),
            logs: [],
            block_height: 1,
            block_hash: BLOCK_HASH,
          });
          return;
        }
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
          status: { SuccessValue: successValueFor(recorded) },
          transaction: { hash: `FakeTxSuccess${String(successCount)}` },
        });
        return;
      }
      writeError(response, id, `unexpected method ${String(body.method)}`);
    });
  });
  function viewResult(methodName: string, args: unknown): unknown {
    if (methodName === 'get_order') {
      const orderRef = isRecord(args) ? args['order_ref'] : undefined;
      const registered = calls.find(
        (call) => call.methodName === 'register_payment' && isRecord(call.args) && call.args['order_ref'] === orderRef,
      );
      if (registered === undefined || !isRecord(registered.args)) return null;
      return {
        amount_received: registered.args['amount_received'],
        refunded: '0',
        reserved: '0',
        refund_destination: registered.args['refund_destination'],
        origin_asset: registered.args['origin_asset'],
        fulfilled: false,
      };
    }
    if (methodName === 'get_request') {
      const requestId = isRecord(args) ? args['request_id'] : undefined;
      const request = requests.find((item) => item.id === requestId);
      if (request === undefined) return null;
      return {
        request_id: request.id,
        status: request.executed ? 'Executed' : request.status,
        submitted: request.executed,
      };
    }
    if (methodName === 'storage_balance_of') {
      if (unregistered) {
        unregistered = false;
        return null;
      }
      return { total: '1250000000000000000000', available: '0' };
    }
    return null;
  }

  function successValueFor(recorded: RecordedCall | undefined): string {
    if (recorded?.methodName === 'request_refund') {
      const status = escalate ? 'Escalated' : 'Approved';
      escalate = false;
      const id = String(requests.length + 1);
      requests.push({ id, status, executed: false });
      return Buffer.from(JSON.stringify({ request_id: id, status })).toString('base64');
    }
    if (recorded?.methodName === 'execute_refund' && isRecord(recorded.args)) {
      const args = recorded.args;
      const request = requests.find((item) => item.id === args['request_id']);
      if (request !== undefined) request.executed = true;
    }
    return '';
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    failNext(code, txHash) {
      failures.push({ code, txHash });
    },
    escalateNext() {
      escalate = true;
    },
    unregisteredNext() {
      unregistered = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function argsFromBase64(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
  } catch {
    return {};
  }
}

function write(response: ServerResponse, id: unknown, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function writeError(response: ServerResponse, id: unknown, message: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }));
}

const CALL_METHODS = ['register_payment', 'mark_fulfilled', 'request_refund', 'execute_refund', 'storage_deposit'];

/** Borsh function-call args are a length-prefixed method name followed by length-prefixed JSON bytes. */
function functionCallFrom(bytes: Buffer): RecordedCall | undefined {
  let found: { at: number; call: RecordedCall } | undefined;
  for (const methodName of CALL_METHODS) {
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
              const call = { methodName, args: JSON.parse(bytes.subarray(start, end).toString('utf8')) as unknown };
              if (found === undefined || at < found.at) found = { at, call };
            } catch {
              return undefined;
            }
          }
        }
      }
      from = at + 1;
    }
  }
  return found?.call;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
