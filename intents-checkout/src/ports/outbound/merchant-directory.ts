export type WebhookTarget = {
  url: string;
  secret: string;
};

export type MerchantDirectory = {
  /** Upsert the single `default` merchant by key hash; returns its id. */
  ensureDefault(apiKeyHash: string, webhookSecret: string): Promise<string>;
  /** Sets the delivery URL. Does not change the secret. */
  setWebhookUrl(merchantId: string, url: string): Promise<void>;
  /** Undefined when the merchant does not exist. An empty url means delivery is not configured. */
  getWebhookTarget(merchantId: string): Promise<WebhookTarget | undefined>;
};
