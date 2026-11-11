import type { ListAssets } from '../asset/asset-service.js';
import type { IntentsGateway } from '../../ports/outbound/intents-gateway.js';
import type { PaymentRepository } from '../../ports/outbound/payment-repository.js';

export const DEFAULT_PAYMENT_WINDOW_MINUTES = 30;
export const DEFAULT_QUOTE_SLIPPAGE_BPS = 100;
export const QUOTE_WAITING_TIME_MS = 2_000;
/** Native USDC (NEP-141) on NEAR. */
export const DEFAULT_DESTINATION_ASSET_ID =
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export type PaymentSettings = {
  treasuryAccountId?: string;
  destinationAssetId: string;
  paymentWindowMinutes: number;
  slippageBps: number;
};

export type PaymentCreationDeps = {
  quotes: Pick<IntentsGateway, 'requestQuote'>;
  assets: ListAssets;
  payments: PaymentRepository;
  clock: () => Date;
  settings: PaymentSettings;
};

export type PaymentReadDeps = {
  payments: Pick<PaymentRepository, 'findById'>;
};
