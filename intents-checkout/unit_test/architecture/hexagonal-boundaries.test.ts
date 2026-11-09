import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const trees = ['domain', 'ports'];
const forbidden =
  /from\s+['"](?:fastify|drizzle-orm(?:\/[^'"]*)?|pg|pino|near-api-js)['"]|from\s+['"][^'"]*\/(?:adaptors|jobs)(?:\/|['"])/;

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
  it('domain and ports do not import adaptors, jobs, or vendor clients', async () => {
    const offenders: string[] = [];
    for (const tree of trees) {
      for (const file of await sourceFiles(path.join(srcRoot, tree))) {
        const source = await readFile(file, 'utf8');
        if (forbidden.test(source)) offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
