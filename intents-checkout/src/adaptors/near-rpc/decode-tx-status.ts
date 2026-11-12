import type { PolicyCallResult } from '../../ports/outbound/policy-ledger.js';

const PANIC_CODE = /E_[A-Z0-9_]+/u;

/** Reads a NEAR transaction result. A bad body is unavailable. This function does not throw. */
export function decodeTxStatus(body: unknown): PolicyCallResult {
  try {
    const value = unwrap(body);
    if (value === undefined) return { status: 'unavailable' };
    const hash = transactionHash(value);
    const status = value['status'];
    if (isSuccess(status)) {
      if (hash === undefined) return { status: 'unavailable' };
      const value = successValue(status);
      return value === undefined ? { status: 'ok', txHash: hash } : { status: 'ok', txHash: hash, value };
    }
    if (isRecord(status) && 'Failure' in status) {
      const code = PANIC_CODE.exec(JSON.stringify(status['Failure']))?.[0];
      if (code !== undefined && hash !== undefined) return { status: 'rejected', code, txHash: hash };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

function unwrap(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const result = body['result'];
  if (isRecord(result) && ('status' in result || 'transaction' in result)) return result;
  return body;
}

function isSuccess(status: unknown): boolean {
  return isRecord(status) && ('SuccessValue' in status || 'SuccessReceiptId' in status);
}

function transactionHash(value: Record<string, unknown>): string | undefined {
  const transaction = value['transaction'];
  if (isRecord(transaction) && typeof transaction['hash'] === 'string' && transaction['hash'].length > 0) {
    return transaction['hash'];
  }
  const outcome = value['transaction_outcome'];
  if (isRecord(outcome) && typeof outcome['id'] === 'string' && outcome['id'].length > 0) return outcome['id'];
  return undefined;
}

/** Base64 JSON in `SuccessValue`. A value that is not JSON is ignored; the call can still be ok. */
function successValue(status: unknown): unknown {
  if (!isRecord(status)) return undefined;
  const encoded = status['SuccessValue'];
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined;
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    if (text.length === 0) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
