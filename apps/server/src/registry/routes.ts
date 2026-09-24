/**
 * Mock HCS registry endpoints. No public registry API exists yet, so these follow the shapes the
 * HCS 1.0 Draft describes (§4.3.2, §4.4.2, §4.4.3, §5, §6.1) and label every record as mock.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { HCS_NAMESPACE, isValidHcsId } from '@grantmark/hcs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import { apiError } from '../http';
import { declarationUrl, subjectRecordUrl } from './view';
import { PublishError, type RegistryStore } from './store';

export const MOCK_NOTICE =
  'Mock record from the Grantmark prototype. Not an authorized HCS Registry, Registration Authority or ' +
  'Governance Board; identifiers are from the HCS reserved test range (HCS 1.0 Draft §4.6).';

const MAX_DECLARATION_BYTES = 1_048_576;

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function registryRoutes(store: RegistryStore, config: Config): Hono {
  const app = new Hono();
  const base = config.publicBaseUrl;
  const xml = (c: Context, body: string) => c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8' });

  app.get('/.well-known/hcs.xml', (c) =>
    xml(
      c,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<hcs:sitemaps xmlns:hcs="${HCS_NAMESPACE}">\n` +
        `  <hcs:sitemap>${escapeXml(`${base}/registry/sitemap.xml`)}</hcs:sitemap>\n` +
        '</hcs:sitemaps>\n',
    ),
  );

  app.get('/registry/sitemap.xml', (c) => {
    const urls = store
      .declarations()
      .map(
        (d) =>
          `  <url>\n    <loc>${escapeXml(declarationUrl(base, d.hcrn))}</loc>\n` +
          `    <lastmod>${d.firstPublishedAt.toISOString()}</lastmod>\n  </url>\n`,
      )
      .join('');
    return xml(
      c,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>\n`,
    );
  });

  app.get('/registry/declarations/:hcrn', (c) => {
    const hcrn = c.req.param('hcrn');
    if (!isValidHcsId(hcrn, 'HCRN')) return apiError(c, 400, 'invalid_request', `${hcrn} is not a valid HCRN`);
    const declaration = store.declaration(hcrn);
    if (declaration === undefined) return apiError(c, 404, 'not_found', `no declaration is published for ${hcrn}`);

    const etag = `"${declaration.sha256}"`;
    const headers = {
      etag,
      'last-modified': declaration.firstPublishedAt.toUTCString(),
      'cache-control': 'no-cache',
    };
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch !== undefined && ifNoneMatch.split(',').some((tag) => [etag, '*'].includes(tag.trim()))) {
      return c.body(null, 304, headers);
    }
    // Copy into an ArrayBuffer-backed view, which is what Hono's body type accepts.
    return c.body(new Uint8Array(declaration.content), 200, { ...headers, 'content-type': 'application/rsl+xml' });
  });

  app.get('/registry/lookup/:id', (c) => {
    const id = c.req.param('id');
    if (isValidHcsId(id, 'HCRN')) {
      const declaration = store.declaration(id);
      if (declaration === undefined) return apiError(c, 404, 'not_found', `${id} is not assigned in this mock registry`);
      return c.json({
        hcrn: id,
        declaration: declarationUrl(base, id),
        registry: declaration.registry,
        available_since: declaration.firstPublishedAt.toISOString(),
        version: declaration.version,
        mock: true,
        notice: MOCK_NOTICE,
      });
    }
    if (isValidHcsId(id, 'HCSI')) {
      const subject = store.subject(id);
      if (subject === undefined) return apiError(c, 404, 'not_found', `${id} is not assigned in this mock registry`);
      return c.json({
        hcsi: id,
        status: subject.status,
        subject_record: subject.status === 'active' ? subjectRecordUrl(base, id) : null,
        mock: true,
        notice: MOCK_NOTICE,
      });
    }
    return apiError(c, 400, 'invalid_request', `${id} is not a valid HCRN or HCSI`);
  });

  app.get('/registry/subjects/:hcsi', (c) => {
    const hcsi = c.req.param('hcsi');
    if (!isValidHcsId(hcsi, 'HCSI')) return apiError(c, 400, 'invalid_request', `${hcsi} is not a valid HCSI`);
    const subject = store.subject(hcsi);
    if (subject === undefined) return apiError(c, 404, 'not_found', `no Rights Subject Record for ${hcsi}`);
    return c.body(JSON.stringify(subject.record, null, 2), 200, { 'content-type': 'application/ld+json' });
  });

  app.get('/registry/authorization', (c) =>
    c.json({
      mock: true,
      notice: MOCK_NOTICE,
      registries: store.registries().map((r) => ({
        registry: r.url,
        name: r.name,
        authorized: r.authorized,
        territory: r.territory ?? null,
      })),
    }),
  );

  const adminToken = config.adminToken;
  if (adminToken !== undefined) {
    app.post('/registry/admin/declarations', bodyLimit({ maxSize: MAX_DECLARATION_BYTES }), async (c) => {
      const header = c.req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!sameSecret(token, adminToken)) return apiError(c, 401, 'invalid_client', 'a valid admin bearer token is required');
      try {
        const result = store.publish(new Uint8Array(await c.req.arrayBuffer()));
        return c.json(result, result.changed ? 201 : 200);
      } catch (error) {
        if (error instanceof PublishError) return apiError(c, 400, error.code, error.message);
        throw error;
      }
    });
  }

  return app;
}
