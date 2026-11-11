import type { Pool } from 'pg';
import type { MerchantDirectory } from '../../ports/outbound/merchant-directory.js';

export function createPostgresMerchantDirectory(pool: Pool): MerchantDirectory {
  return {
    async ensureDefault(apiKeyHash, webhookSecret) {
      // webhook_url '' means not configured. The secret is only written on insert.
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

    async setWebhookUrl(merchantId, url) {
      await pool.query(`UPDATE merchants SET webhook_url = $2 WHERE id = $1`, [merchantId, url]);
    },

    async getWebhookTarget(merchantId) {
      const result = await pool.query<{ webhook_url: string; webhook_secret: string }>(
        `SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1`,
        [merchantId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return { url: row.webhook_url, secret: row.webhook_secret };
    },
  };
}
