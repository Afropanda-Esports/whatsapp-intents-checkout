export type WebhookDelivery = {
  url: string;
  body: string;
  signature: string;
};

export type WebhookSendResult = { delivered: true } | { delivered: false; reason: string };

export type WebhookSender = {
  /** 2xx is delivered. Network errors, timeouts, redirects, and other statuses are not, with a reason. Never throws. */
  send(delivery: WebhookDelivery): Promise<WebhookSendResult>;
};
