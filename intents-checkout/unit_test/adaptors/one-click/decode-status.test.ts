import { describe, expect, it } from 'vitest';
import { decodeStatus } from '../../../src/adaptors/one-click/decode-status.js';

const emptyHashes = { originChainTxHashes: [], destinationChainTxHashes: [] };

describe('decodeStatus', () => {
  it('keeps a null amountOut on an incomplete deposit', () => {
    expect(
      decodeStatus({
        status: 'INCOMPLETE_DEPOSIT',
        swapDetails: { amountOut: null, depositedAmount: '1000000', ...emptyHashes },
      }),
    ).toEqual({
      oneClickStatus: 'INCOMPLETE_DEPOSIT',
      amountOut: null,
      depositedAmount: '1000000',
      originTxHashes: [],
      destinationTxHashes: [],
    });
  });

  it('treats omitted amounts as null', () => {
    expect(decodeStatus({ status: 'INCOMPLETE_DEPOSIT', swapDetails: emptyHashes })).toEqual({
      oneClickStatus: 'INCOMPLETE_DEPOSIT',
      amountOut: null,
      depositedAmount: null,
      originTxHashes: [],
      destinationTxHashes: [],
    });
  });

  it('keeps a present amountOut string', () => {
    expect(
      decodeStatus({
        status: 'SUCCESS',
        swapDetails: { amountOut: '1000000', depositedAmount: '1014614', ...emptyHashes },
      }),
    ).toMatchObject({ oneClickStatus: 'SUCCESS', amountOut: '1000000' });
  });

  it('returns undefined for an unknown status', () => {
    expect(
      decodeStatus({ status: 'NOT_A_STATUS', swapDetails: emptyHashes }),
    ).toBeUndefined();
  });

  it('returns undefined when swapDetails is missing', () => {
    expect(decodeStatus({ status: 'INCOMPLETE_DEPOSIT' })).toBeUndefined();
  });
});
