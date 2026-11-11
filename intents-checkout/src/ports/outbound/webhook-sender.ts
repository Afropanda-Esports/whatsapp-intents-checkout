export type WebhookDelivery = {
  url: string;
  body: string;
  signature: string;
};

export type WebhookSender = {
  /** 2xx is delivered. Network errors, timeouts, redirects, and other statuses are not. Never throws. */
  send(delivery: WebhookDelivery): Promise<{ delivered: boolean }>;
};
