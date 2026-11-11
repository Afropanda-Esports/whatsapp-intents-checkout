export type MerchantDirectory = {
  /** Upsert the single `default` merchant by key hash; returns its id. */
  ensureDefault(apiKeyHash: string, webhookSecret: string): Promise<string>;
};
