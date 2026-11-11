import type { Pool } from 'pg';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';

export function createPostgresMerchantDirectory(pool: Pool): MerchantDirectory {
  return {
    async ensureDefault(apiKeyHash, webhookSecret) {
      // webhook_url '' = not configured; slice 5 sets real values. The secret is only written on insert.
      const result = await pool.query<{ id: string }>(
        `INSERT INTO merchants (name, api_key_hash, webhook_url, webhook_secret)
         VALUES ('default', $1, '', $2)
         ON CONFLICT (api_key_hash) DO UPDATE SET name = merchants.name
         RETURNING id`,
        [apiKeyHash, webhookSecret],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('merchant upsert returned no id');
      return id;
    },
  };
}
