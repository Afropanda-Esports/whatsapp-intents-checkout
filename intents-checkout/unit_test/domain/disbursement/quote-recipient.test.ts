import { describe, expect, it } from 'vitest';
import { quoteRequestRecipient } from '../../../src/domain/disbursement/quote-recipient.js';
import { exceedsBaseUnits, subtractBaseUnits } from '../../../src/domain/shared/money.js';

describe('refund amount and quote recipient', () => {
  it('subtracts base units without floating point and treats a missing recipient as no recipient', () => {
    expect(subtractBaseUnits('1000000', '500000')).toBe('500000');
    expect(subtractBaseUnits('1', '2')).toBe('0');
    expect(exceedsBaseUnits('9007199254740993', '9007199254740992')).toBe(true);
    expect(quoteRequestRecipient({ quoteRequest: { recipient: 'TCustomer' } })).toBe('TCustomer');
    expect(quoteRequestRecipient({ quoteRequest: {} })).toBeUndefined();
    expect(quoteRequestRecipient(null)).toBeUndefined();
  });
});
