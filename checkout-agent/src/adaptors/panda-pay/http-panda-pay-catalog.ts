import { z } from 'zod';
import { isBaseUnits } from '../../domain/conversation/base-units.js';
import type { CatalogItem } from '../../domain/conversation/types.js';
import type { MerchantCatalog } from '../../ports/outbound/merchant-catalog.js';
import { pandaPayRequest, type PandaPayOptions } from './panda-pay-http.js';

const catalogBody = z.object({
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      price: z.string().refine(isBaseUnits),
    }),
  ),
});

export function createHttpPandaPayCatalog(options: PandaPayOptions): MerchantCatalog {
  return {
    async listCatalog() {
      const payload = await pandaPayRequest({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        path: '/catalog/v1',
        method: 'GET',
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const parsed = catalogBody.safeParse(payload);
      if (!parsed.success) throw new Error('catalog-unavailable');
      return parsed.data.items.map((item): CatalogItem => ({ sku: item.sku, name: item.name, price: item.price }));
    },
  };
}
