import { z } from 'zod';

const schema = z.object({
  PORT: z
    .string({ required_error: 'PORT is required' })
    .regex(/^[0-9]+$/u, 'PORT must be an integer')
    .transform((value) => Number(value))
    .refine((value) => value >= 1 && value <= 65535, 'PORT must be between 1 and 65535'),
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1),
});

export type AppConfig = {
  port: number;
  databaseUrl: string;
};

/**
 * Reads the two values the process needs before it can listen.
 * Other environment variables are ignored so probes never depend on them.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse({
    PORT: env['PORT'],
    DATABASE_URL: env['DATABASE_URL'],
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return {
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
