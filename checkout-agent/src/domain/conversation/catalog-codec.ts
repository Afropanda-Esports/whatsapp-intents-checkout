import { isBaseUnits } from './base-units.js';
import type { CatalogItem } from './types.js';

export function encodeCatalog(items: readonly CatalogItem[]): string {
  return JSON.stringify(items.map((item) => ({ sku: item.sku, name: item.name, price: item.price })));
}

/** Bad JSON or a float price is dropped. Never throws. */
export function decodeCatalog(raw: string | undefined): CatalogItem[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: CatalogItem[] = [];
  for (const entry of parsed) {
    const item = readItem(entry);
    if (item !== undefined) items.push(item);
  }
  return items;
}

function readItem(entry: unknown): CatalogItem | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  if (!('sku' in entry) || !('name' in entry) || !('price' in entry)) return undefined;
  const { sku, name, price } = entry;
  if (typeof sku !== 'string' || typeof name !== 'string' || typeof price !== 'string') return undefined;
  if (!isBaseUnits(price)) return undefined;
  return { sku, name, price };
}
