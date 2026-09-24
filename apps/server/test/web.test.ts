import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, createServices } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';

const config = loadConfig({});

function appWithDist() {
  const dist = mkdtempSync(join(tmpdir(), 'grantmark-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Grantmark</title>');
  writeFileSync(join(dist, 'assets', 'app-1234.js'), 'console.log(1)');
  return createApp(createServices(openDatabase(':memory:'), config), config, { webDist: dist });
}

describe('serving the web app', () => {
  it('serves index.html at the root', async () => {
    const response = await appWithDist().request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('<title>Grantmark</title>');
  });

  it('serves hashed assets with a long cache lifetime', async () => {
    const response = await appWithDist().request('/assets/app-1234.js');
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('never serves files outside the build folder', async () => {
    const app = appWithDist();
    expect((await app.request('/assets/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await app.request('/%2e%2e/%2e%2e/package.json')).status).toBe(404);
  });

  it('keeps API errors as JSON', async () => {
    const response = await appWithDist().request('/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers 404 for missing assets', async () => {
    expect((await appWithDist().request('/assets/missing.js')).status).toBe(404);
  });

  it('works without a build', async () => {
    const app = createApp(createServices(openDatabase(':memory:'), config), config, { webDist: join(tmpdir(), 'grantmark-no-such-dir') });
    const response = await app.request('/');
    expect(response.status).toBe(404);
  });
});
