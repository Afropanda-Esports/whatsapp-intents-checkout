export type UserIntent =
  | { kind: 'buy'; sku: string }
  | { kind: 'price'; sku: string }
  | { kind: 'status' }
  | { kind: 'refund'; address: string }
  | { kind: 'payout'; account: string }
  | { kind: 'other' };

const SKU = /\b([a-z][a-z0-9]*-\d+)\b/iu;

export function classifyMessage(text: string): UserIntent {
  if (/\brefund\b/iu.test(text)) {
    const address = text.match(/\baddress\s+([A-Za-z0-9:._-]+)/iu)?.[1] ?? 'user-supplied-address';
    return { kind: 'refund', address };
  }
  if (/\b(supplier|payout)\b/iu.test(text)) {
    const account = text.match(/\baccount\s+([A-Za-z0-9:._-]+)/iu)?.[1] ?? 'supplier';
    return { kind: 'payout', account };
  }
  const sku = text.match(SKU)?.[1]?.toLowerCase();
  if (sku === undefined) {
    if (/\bstatus\b/iu.test(text)) return { kind: 'status' };
    return { kind: 'other' };
  }
  if (/\b(how much|price|cost)\b/iu.test(text)) return { kind: 'price', sku };
  return { kind: 'buy', sku };
}

export function normalizeUtterance(text: string): string {
  return text.trim().toLowerCase();
}
