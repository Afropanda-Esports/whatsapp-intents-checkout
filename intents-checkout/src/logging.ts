import { pino, type DestinationStream, type Logger } from 'pino';

const REDACTED_PATHS = [
  'databaseUrl',
  'DATABASE_URL',
  'oneClickApiKey',
  'ONE_CLICK_API_KEY',
  'operatorPrivateKey',
  'OPERATOR_PRIVATE_KEY',
] as const;

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    // `err` carries `errorFields()` output; pino's default serializer would replace it.
    serializers: { err: (value: unknown) => value },
    redact: {
      paths: [...REDACTED_PATHS],
      remove: true,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export type ErrorFields = { name?: string; code?: string; message: string; cause?: string };

const CAUSE_DEPTH = 5;

/**
 * Name, code and message of a thrown value, for an `err` log field. No stack.
 * Drivers wrap errors (Drizzle: "Failed query: …" with the pg error as `cause`),
 * so `code` is the first one found down the cause chain and `cause` is the
 * innermost message.
 */
export function errorFields(err: unknown): ErrorFields {
  if (!(err instanceof Error)) return { message: 'non-error thrown' };
  const fields: ErrorFields = { name: err.name, message: err.message };
  let current: unknown = err;
  let innermost: Error | undefined;
  for (let depth = 0; depth < CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (fields.code === undefined && 'code' in current && typeof current.code === 'string') {
      fields.code = current.code;
    }
    if (current !== err) innermost = current;
    current = current.cause;
  }
  if (innermost !== undefined) fields.cause = innermost.message;
  return fields;
}
