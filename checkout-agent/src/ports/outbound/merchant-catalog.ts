import type { CatalogItem } from '../../domain/conversation/types.js';

export type MerchantCatalog = {
  listCatalog(): Promise<readonly CatalogItem[]>;
};
