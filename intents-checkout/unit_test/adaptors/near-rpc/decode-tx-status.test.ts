import { describe, expect, it } from 'vitest';
import { decodeTxStatus } from '../../../src/adaptors/near-rpc/decode-tx-status.js';

const HASH = 'FakeTxHash11111111111111111111111111111111';

describe('decodeTxStatus', () => {
  it('reads the hash from a success value', () => {
    expect(
      decodeTxStatus({
        status: { SuccessValue: '' },
        transaction: { hash: HASH },
      }),
    ).toEqual({ status: 'ok', txHash: HASH });
  });

  it('reads the first panic code from a failed transaction', () => {
    expect(
      decodeTxStatus({
        status: {
          Failure: {
            ActionError: {
              kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_PAUSED' } },
            },
          },
        },
        transaction: { hash: HASH },
      }),
    ).toEqual({ status: 'rejected', code: 'E_PAUSED', txHash: HASH });
  });

  it('does not throw when the body is not a transaction', () => {
    expect(decodeTxStatus('not-a-transaction')).toEqual({ status: 'unavailable' });
    expect(decodeTxStatus(null)).toEqual({ status: 'unavailable' });
    expect(decodeTxStatus({ status: { Failure: { ActionError: 'ExecutionError' } } })).toEqual({ status: 'unavailable' });
  });
});
