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
    redact: {
      paths: [...REDACTED_PATHS],
      remove: true,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
