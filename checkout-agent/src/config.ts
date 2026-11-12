import { z } from 'zod';

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().url().optional(),
);

const schema = z.object({
  PORT: z.preprocess(
    (value) => (value === undefined || value === '' ? '3100' : value),
    z
      .string()
      .regex(/^[0-9]+$/u, 'PORT must be an integer')
      .transform((value) => Number(value))
      .refine((value) => value >= 1 && value <= 65535, 'PORT must be between 1 and 65535'),
  ),
  PANDA_PAY_BASE_URL: optionalUrl,
  PANDA_PAY_API_KEY: optionalText,
  CHECKOUT_BASE_URL: optionalUrl,
  CHECKOUT_API_KEY: optionalText,
  INTENTS_CHECKOUT_AGENT_KEY: optionalText,
  LLM_BASE_URL: optionalUrl,
  LLM_API_KEY: optionalText,
  LLM_MODEL: optionalText,
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  WHATSAPP_ACCESS_TOKEN: optionalText,
});

export type AppConfig = {
  port: number;
  pandaPayBaseUrl?: string;
  pandaPayApiKey?: string;
  checkoutBaseUrl?: string;
  checkoutApiKey?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  whatsapp?: {
    phoneNumberId: string;
    accessToken: string;
  };
};

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse({
    PORT: env['PORT'],
    PANDA_PAY_BASE_URL: env['PANDA_PAY_BASE_URL'],
    PANDA_PAY_API_KEY: env['PANDA_PAY_API_KEY'],
    CHECKOUT_BASE_URL: env['CHECKOUT_BASE_URL'],
    CHECKOUT_API_KEY: env['CHECKOUT_API_KEY'],
    INTENTS_CHECKOUT_AGENT_KEY: env['INTENTS_CHECKOUT_AGENT_KEY'],
    LLM_BASE_URL: env['LLM_BASE_URL'],
    LLM_API_KEY: env['LLM_API_KEY'],
    LLM_MODEL: env['LLM_MODEL'],
    WHATSAPP_PHONE_NUMBER_ID: env['WHATSAPP_PHONE_NUMBER_ID'],
    WHATSAPP_ACCESS_TOKEN: env['WHATSAPP_ACCESS_TOKEN'],
  });
  if (!parsed.success) throw new Error('invalid configuration');
  const data = parsed.data;
  const checkoutApiKey = data.CHECKOUT_API_KEY ?? data.INTENTS_CHECKOUT_AGENT_KEY;
  const config: AppConfig = { port: data.PORT };
  if (data.PANDA_PAY_BASE_URL !== undefined) config.pandaPayBaseUrl = data.PANDA_PAY_BASE_URL;
  if (data.PANDA_PAY_API_KEY !== undefined) config.pandaPayApiKey = data.PANDA_PAY_API_KEY;
  if (data.CHECKOUT_BASE_URL !== undefined) config.checkoutBaseUrl = data.CHECKOUT_BASE_URL;
  if (checkoutApiKey !== undefined) config.checkoutApiKey = checkoutApiKey;
  if (data.LLM_BASE_URL !== undefined) config.llmBaseUrl = data.LLM_BASE_URL;
  if (data.LLM_API_KEY !== undefined) config.llmApiKey = data.LLM_API_KEY;
  if (data.LLM_MODEL !== undefined) config.llmModel = data.LLM_MODEL;
  if (data.WHATSAPP_PHONE_NUMBER_ID !== undefined && data.WHATSAPP_ACCESS_TOKEN !== undefined) {
    config.whatsapp = {
      phoneNumberId: data.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: data.WHATSAPP_ACCESS_TOKEN,
    };
  }
  return config;
}
