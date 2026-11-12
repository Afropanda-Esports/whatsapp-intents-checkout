import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcRoot = path.join(packageRoot, 'src');
const forbiddenImport =
  /from\s+['"]fastify['"]|from\s+['"][^'"]*\/adaptors\/|from\s+['"]node-fetch['"]|[^A-Za-z0-9_]fetch\s*\(/u;

async function sourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

describe('hexagonal boundaries', () => {
  it('domain and ports do not import fastify, fetch, or an adaptor path', async () => {
    const offenders: string[] = [];
    for (const tree of ['domain', 'ports']) {
      for (const file of await sourceFiles(path.join(srcRoot, tree))) {
        const source = await readFile(file, 'utf8');
        if (forbiddenImport.test(source)) offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not depend on postgres, drizzle, or a NEAR library', async () => {
    const offenders: string[] = [];
    const banned = /drizzle-orm|from\s+['"]pg['"]|near-api-js|NEAR_PRIVATE|private_key|ed25519/u;
    for (const file of await sourceFiles(srcRoot)) {
      const source = await readFile(file, 'utf8');
      if (banned.test(source)) offenders.push(path.relative(srcRoot, file));
    }
    expect(offenders).toEqual([]);
  });

  it('publishes POST /chat/v1 request and 200 response', async () => {
    const openapi = await readFile(path.join(packageRoot, 'openapi.yaml'), 'utf8');
    expect(openapi).toContain('/chat/v1:');
    expect(openapi).toContain('ChatRequest');
    expect(openapi).toContain('ChatResponse');
    expect(openapi).toContain("conversationId: judge-1");
  });
});
