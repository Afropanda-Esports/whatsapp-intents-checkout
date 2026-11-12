/**
 * The recipient echoed on a 1Click quote request. Missing or non-string is undefined.
 * This does not throw: a refund treats undefined as a mismatch.
 */
export function quoteRequestRecipient(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const request = payload['quoteRequest'];
  if (!isRecord(request)) return undefined;
  const recipient = request['recipient'];
  return typeof recipient === 'string' && recipient.length > 0 ? recipient : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
