import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/logging.js';

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
