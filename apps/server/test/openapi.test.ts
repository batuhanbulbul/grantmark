import { describe, expect, it } from 'vitest';
import { createApp, createServices } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';

const config = loadConfig({ ADMIN_TOKEN: 'test-admin-token-123456' });
const app = createApp(createServices(openDatabase(':memory:'), config), config, { webDist: 'no-such-folder' });

describe('GET /health', () => {
  it('reports that the server is up', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /openapi.json', () => {
  it('describes the API as OpenAPI 3.1', async () => {
    const response = await app.request('/openapi.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as { openapi: string; info: { title: string }; paths: Record<string, Record<string, unknown>> };
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Grantmark');
  });

  it('documents exactly the routes the server has', async () => {
    const document = (await (await app.request('/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> };
    const routes = new Set(
      app.routes
        .filter((r) => r.method !== 'ALL' && r.path !== '*' && r.path !== '/openapi.json')
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    );
    const documented = new Set(
      Object.entries(document.paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`)),
    );
    expect([...routes].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !routes.has(r))).toEqual([]);
  });
});
