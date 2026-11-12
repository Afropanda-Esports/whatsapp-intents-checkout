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
      return hash === undefined ? { status: 'unavailable' } : { status: 'ok', txHash: hash };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
