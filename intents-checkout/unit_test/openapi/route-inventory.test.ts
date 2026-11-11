import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/adaptors/fastify/server.js';
import { createLogger } from '../../src/logging.js';

/** Paths and lowercase methods from the `paths:` block of openapi.yaml (two-space indentation). */
function openapiOperations(yaml: string): Array<{ method: string; path: string }> {
  const operations: Array<{ method: string; path: string }> = [];
  let inPaths = false;
  let current: string | undefined;
  for (const line of yaml.split('\n')) {
    if (/^paths:\s*$/u.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/u.test(line)) inPaths = false;
    if (!inPaths) continue;
    const path = /^ {2}(\/\S*):\s*$/u.exec(line);
    if (path) current = path[1];
    const method = /^ {4}(get|post|put|patch|delete):\s*$/u.exec(line);
    if (method && current !== undefined) operations.push({ method: method[1] as string, path: current });
  }
  return operations;
}

/** Rebuild full paths from Fastify's route tree: each level is indented by 4 columns. */
function registeredRoutes(tree: string): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^([│ ]*)(?:├── |└── )(\/\S*)(?: \(([A-Z, ]+)\))?/u.exec(line);
    if (!match) continue;
    const depth = (match[1] as string).length / 4;
    stack.length = depth;
    stack.push(match[2] as string);
    const methods = match[3];
    if (methods === undefined) continue;
    const path = stack.join('');
    for (const method of methods.split(', ')) if (method !== 'HEAD') routes.push(`${method} ${path}`);
  }
  return routes;
}

const notDocumented = new Set(['GET /health/live', 'GET /health/ready']);

describe('openapi.yaml route inventory', () => {
  it('documents every merchant route the server registers, and only those', async () => {
    const yaml = await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8');
    const documented = openapiOperations(yaml).map((op) => `${op.method.toUpperCase()} ${op.path.replace(/\{(\w+)\}/gu, ':$1')}`);
    expect(documented.length).toBeGreaterThan(0);

    const app = await buildServer({
      checkLive: () => ({ status: 'live' }),
      checkReady: async () => ({ status: 'ready', checks: { config: 'ok', postgres: 'up' } }),
      logger: createLogger(),
      assets: { authenticate: () => {}, listAssets: vi.fn(async () => []), publicBaseUrl: 'https://x' },
      payments: {
        authenticate: () => {},
        createPayment: vi.fn(),
        getPayment: vi.fn(),
        merchantId: 'm',
        publicBaseUrl: 'https://x',
      },
    });
    for (const operation of documented) {
      const [method, url] = operation.split(' ') as [string, string];
      expect(app.hasRoute({ method: method as 'GET', url }), operation).toBe(true);
    }
    const registered = registeredRoutes(app.printRoutes({ commonPrefix: false }));
    expect(registered.length).toBeGreaterThan(0);
    for (const route of registered) {
      if (notDocumented.has(route)) continue;
      expect(documented, route).toContain(route);
    }
    await app.close();
  });
});
