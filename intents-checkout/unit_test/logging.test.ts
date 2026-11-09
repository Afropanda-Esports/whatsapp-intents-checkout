import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, errorFields } from '../src/logging.js';

describe('logger', () => {
  it('writes one JSON line with correlationId and without a connection string', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger(stream as DestinationStream);
    logger.info(
      { correlationId: 'cid-1', databaseUrl: 'postgres://user:secret@localhost/db' },
      'request',
    );
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['correlationId']).toBe('cid-1');
    const encoded = JSON.stringify(parsed);
    expect(encoded).not.toContain('postgres://');
    expect(encoded).not.toContain('secret');
  });
});

describe('errorFields', () => {
  it('keeps name, code and message from a pg-style error and drops the stack', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const fields = errorFields(err);
    expect(fields).toEqual({ name: 'Error', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' });
    expect(fields).not.toHaveProperty('stack');
  });

  it('omits code when the error has none', () => {
    expect(errorFields(new TypeError('bad'))).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('falls back for a non-Error value', () => {
    expect(errorFields('boom')).toEqual({ message: 'non-error thrown' });
  });
});

describe('errorFields with wrapped errors', () => {
  it('takes the code from the cause chain and reports the innermost message', () => {
    const pgError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const wrapped = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', { cause: pgError });
    expect(errorFields(wrapped)).toEqual({
      name: 'Error',
      code: 'ECONNREFUSED',
      message: 'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"',
      cause: 'connect ECONNREFUSED 127.0.0.1:1',
    });
  });

  it('is written to the log as given, not rewritten by the default err serializer', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    createLogger(stream as DestinationStream).error({ err: errorFields(new Error('x')) }, 'failed');
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['err']).toEqual({ name: 'Error', message: 'x' });
  });
});
