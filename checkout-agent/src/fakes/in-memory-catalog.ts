import type { CatalogItem } from '../domain/conversation/types.js';
import type { MerchantCatalog } from '../ports/outbound/merchant-catalog.js';

export const PSN_10: CatalogItem = { sku: 'psn-10', name: 'PSN 10', price: '1000000' };

export function createInMemoryCatalog(trace: string[]): MerchantCatalog {
  return {
    async listCatalog() {
      trace.push('list_catalog');
      return [{ sku: PSN_10.sku, name: PSN_10.name, price: PSN_10.price }];
    },
  };
}
