import { z } from 'zod';

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().url().optional(),
);

const optionalPositiveInt = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z
      .string()
      .regex(/^[0-9]+$/u, 'must be an integer')
      .transform((value) => Number(value))
      .refine((value) => value >= 1 && value <= max, `must be between 1 and ${max}`)
      .optional(),
  );

const schema = z.object({
  PORT: z
    .string({ required_error: 'PORT is required' })
    .regex(/^[0-9]+$/u, 'PORT must be an integer')
    .transform((value) => Number(value))
    .refine((value) => value >= 1 && value <= 65535, 'PORT must be between 1 and 65535'),
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1),
  PUBLIC_BASE_URL: optionalUrl,
  ONE_CLICK_BASE_URL: optionalUrl,
  ONE_CLICK_API_KEY: optionalText,
  MERCHANT_API_KEY: optionalText,
  TREASURY_ACCOUNT_ID: optionalText,
  DESTINATION_ASSET_ID: optionalText,
  PAYMENT_WINDOW_MINUTES: optionalPositiveInt(1440),
  QUOTE_SLIPPAGE_BPS: optionalPositiveInt(1000),
  WEBHOOK_URL: optionalUrl,
});

export type AppConfig = {
  port: number;
  databaseUrl: string;
  publicBaseUrl?: string;
  oneClickBaseUrl?: string;
  oneClickApiKey?: string;
  merchantApiKey?: string;
  treasuryAccountId?: string;
  destinationAssetId?: string;
  paymentWindowMinutes?: number;
  quoteSlippageBps?: number;
  webhookUrl?: string;
};

/**
 * PORT and DATABASE_URL are required before listen.
 * Public URL, 1Click, the merchant key and payment settings are read when set. Probes do not use them.
 * Payment defaults (30 min window, 100 bps, native USDC) live in the domain, not here.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse({
    PORT: env['PORT'],
    DATABASE_URL: env['DATABASE_URL'],
    PUBLIC_BASE_URL: env['PUBLIC_BASE_URL'],
    ONE_CLICK_BASE_URL: env['ONE_CLICK_BASE_URL'],
    ONE_CLICK_API_KEY: env['ONE_CLICK_API_KEY'],
    MERCHANT_API_KEY: env['MERCHANT_API_KEY'],
    TREASURY_ACCOUNT_ID: env['TREASURY_ACCOUNT_ID'],
    DESTINATION_ASSET_ID: env['DESTINATION_ASSET_ID'],
    PAYMENT_WINDOW_MINUTES: env['PAYMENT_WINDOW_MINUTES'],
    QUOTE_SLIPPAGE_BPS: env['QUOTE_SLIPPAGE_BPS'],
    WEBHOOK_URL: env['WEBHOOK_URL'],
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const config: AppConfig = {
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
  };
  if (parsed.data.PUBLIC_BASE_URL !== undefined) {
    config.publicBaseUrl = parsed.data.PUBLIC_BASE_URL.replace(/\/$/u, '');
  }
  if (parsed.data.ONE_CLICK_BASE_URL !== undefined) config.oneClickBaseUrl = parsed.data.ONE_CLICK_BASE_URL;
  if (parsed.data.ONE_CLICK_API_KEY !== undefined) config.oneClickApiKey = parsed.data.ONE_CLICK_API_KEY;
  if (parsed.data.MERCHANT_API_KEY !== undefined) config.merchantApiKey = parsed.data.MERCHANT_API_KEY;
  if (parsed.data.TREASURY_ACCOUNT_ID !== undefined) config.treasuryAccountId = parsed.data.TREASURY_ACCOUNT_ID;
  if (parsed.data.DESTINATION_ASSET_ID !== undefined) config.destinationAssetId = parsed.data.DESTINATION_ASSET_ID;
  if (parsed.data.PAYMENT_WINDOW_MINUTES !== undefined) config.paymentWindowMinutes = parsed.data.PAYMENT_WINDOW_MINUTES;
  if (parsed.data.QUOTE_SLIPPAGE_BPS !== undefined) config.quoteSlippageBps = parsed.data.QUOTE_SLIPPAGE_BPS;
  if (parsed.data.WEBHOOK_URL !== undefined) config.webhookUrl = parsed.data.WEBHOOK_URL;
  return config;
}
