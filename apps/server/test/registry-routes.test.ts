import { parseHcsDocument, parseTimestamp, readXml } from '@grantmark/hcs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { RegistryStore } from '../src/registry/store';
import { seedPersonas } from '../src/seed';

const BASE = 'https://grantmark.test';
const config = loadConfig({ PUBLIC_BASE_URL: BASE, ADMIN_TOKEN: 'test-admin-token-123456' });
const MIRA_HCRN = 'HCRN-0000-0068-F';
const MIRA_HCSI = 'HCSI-0000-0034-T';

let store: RegistryStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new RegistryStore(openDatabase(':memory:'), () => new Date('2026-09-20T10:00:00Z'));
  seedPersonas(store, config);
  app = createApp({ store, config });
});

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe('GET /.well-known/hcs.xml (HCS §5.2.1)', () => {
  it('lists the registry sitemap', async () => {
    const response = await get('/.well-known/hcs.xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = readXml(await response.text());
    if (!xml.ok) throw new Error(xml.error.message);
    expect(xml.root).toMatchObject({ local: 'sitemaps', uri: 'https://humanconsent.org/hcs' });
    expect(xml.root.children.map((c) => [c.local, c.text.trim()])).toEqual([['sitemap', `${BASE}/registry/sitemap.xml`]]);
  });
});

describe('GET /registry/sitemap.xml (HCS §5.1)', () => {
  it('lists every current declaration with a full timestamp', async () => {
    const response = await get('/registry/sitemap.xml');
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = readXml(await response.text());
    if (!xml.ok) throw new Error(xml.error.message);
    expect(xml.root).toMatchObject({ local: 'urlset', uri: 'http://www.sitemaps.org/schemas/sitemap/0.9' });
    const entries = xml.root.children.map((url) => Object.fromEntries(url.children.map((c) => [c.local, c.text])));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({ loc: `${BASE}/registry/declarations/HCRN-0000-006B-J`, lastmod: '2026-09-20T10:00:00.000Z' });
    for (const entry of entries) expect(parseTimestamp(entry.lastmod!)).toBeDefined();
  });
});

describe('GET /registry/declarations/:hcrn', () => {
  it('serves the exact stored bytes as application/rsl+xml with validators', async () => {
    const response = await get(`/registry/declarations/${MIRA_HCRN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/rsl+xml');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(store.declaration(MIRA_HCRN)!.content);
    expect(response.headers.get('etag')).toBe(`"${store.declaration(MIRA_HCRN)!.sha256}"`);
    expect(response.headers.get('last-modified')).toBe('Sun, 20 Sep 2026 10:00:00 GMT');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const etag = (await get(`/registry/declarations/${MIRA_HCRN}`)).headers.get('etag')!;
    const response = await get(`/registry/declarations/${MIRA_HCRN}`, { 'if-none-match': etag });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  it('serves declarations that name the configured registry and license server', async () => {
    const parsed = parseHcsDocument(await (await get(`/registry/declarations/${MIRA_HCRN}`)).text());
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.document.rights[0]?.attributes).toMatchObject({
      registry: config.registryId,
      server: config.licenseServerUrl,
    });
  });

  it('answers 404 for an unknown HCRN and 400 for a malformed one', async () => {
    const missing = await get('/registry/declarations/HCRN-0000-00ZZ-R');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
    const malformed = await get('/registry/declarations/HCRN-0000-0068-G');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('GET /registry/lookup/:id (HCS §4.3.2, §4.4.3)', () => {
  it('returns the HCRN lookup record', async () => {
    const response = await get(`/registry/lookup/${MIRA_HCRN}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hcrn: MIRA_HCRN,
      declaration: `${BASE}/registry/declarations/${MIRA_HCRN}`,
      registry: config.registryId,
      available_since: '2026-09-20T10:00:00.000Z',
      version: 1,
      mock: true,
    });
  });

  it('returns the HCSI lookup record', async () => {
    const response = await get(`/registry/lookup/${MIRA_HCSI}`);
    expect(await response.json()).toMatchObject({
      hcsi: MIRA_HCSI,
      status: 'active',
      subject_record: `${BASE}/registry/subjects/${MIRA_HCSI}`,
      mock: true,
    });
  });

  it('answers 404 for unknown and 400 for malformed identifiers', async () => {
    expect((await get('/registry/lookup/HCSI-0000-00ZZ-R')).status).toBe(404);
    expect((await get('/registry/lookup/nope')).status).toBe(400);
  });
});

describe('GET /registry/subjects/:hcsi (HCS §4.4.2)', () => {
  it('serves the Rights Subject Record as JSON-LD', async () => {
    const response = await get(`/registry/subjects/${MIRA_HCSI}`);
    expect(response.headers.get('content-type')).toBe('application/ld+json');
    expect(await response.json()).toEqual(store.subject(MIRA_HCSI)!.record);
  });

  it('answers 404 for an unknown HCSI', async () => {
    expect((await get('/registry/subjects/HCSI-0000-00ZZ-R')).status).toBe(404);
  });
});

describe('GET /registry/authorization (mock Governance Board record, HCS §6.1)', () => {
  it('lists both mock registries as authorized', async () => {
    const body = await (await get('/registry/authorization')).json();
    expect(body.mock).toBe(true);
    expect(body.registries).toEqual([
      { registry: config.registryId, name: expect.any(String), authorized: true, territory: null },
      { registry: 'https://registry.harbor-agency.example', name: expect.any(String), authorized: true, territory: null },
    ]);
  });
});

describe('POST /registry/admin/declarations', () => {
  const post = (body: string, token?: string) =>
    app.request('/registry/admin/declarations', {
      method: 'POST',
      headers: { 'content-type': 'application/rsl+xml', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
  const current = () => new TextDecoder().decode(store.declaration(MIRA_HCRN)!.content);

  it('requires the admin token', async () => {
    expect((await post(current())).status).toBe(401);
    expect((await post(current(), 'wrong-token-wrong-token')).status).toBe(401);
  });

  it('publishes a new version', async () => {
    const withdrawn = current().replace('max-age="7"', 'max-age="7" status="withdrawn"');
    const response = await post(withdrawn, 'test-admin-token-123456');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ hcrn: MIRA_HCRN, version: 2, changed: true });
  });

  it('reports unchanged content with 200', async () => {
    const response = await post(current(), 'test-admin-token-123456');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, changed: false });
  });

  it('rejects invalid declarations with 400', async () => {
    const response = await post('<rsl/>', 'test-admin-token-123456');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_declaration' });
  });

  it('is disabled when no admin token is configured', async () => {
    const closed = createApp({ store, config: { ...config, adminToken: undefined } });
    const response = await closed.request('/registry/admin/declarations', { method: 'POST', body: current() });
    expect(response.status).toBe(404);
  });
});

describe('errors', () => {
  it('answers unknown routes with an OAuth-style 404', async () => {
    const response = await get('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', error_description: expect.any(String) });
  });
});
