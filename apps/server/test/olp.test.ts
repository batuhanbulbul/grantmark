import type { DatabaseSync } from 'node:sqlite';
import { HCS_NAMESPACE, RSL_NAMESPACE, canonicalLicense } from '@grantmark/hcs';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createServices, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://grantmark.test',
  REGISTRY_ID: 'https://grantmark.test/registry',
  LICENSE_SERVER_URL: 'https://grantmark.test/olp',
});

const TEST_HCSI = 'HCSI-0000-0039-Z';
const FREE_HCRN = 'HCRN-0000-006E-N';
const CLIENT = { id: 'demo-studio', secret: 'demo-studio-secret-value' };
const LEGAL = '<legal type="attestation">true</legal><legal type="contact">mailto:rights@test-subject.example</legal>';
const FREE_LICENSE = `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`;
const DAY = 24 * 60 * 60 * 1000;

let clock: Date;
let db: DatabaseSync;
let services: Services;
let app: ReturnType<typeof createApp>;

function testDeclaration(hcrn: string, attributes: string, licenses: string, registry = config.registryId) {
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@id': `https://id.humanconsent.org/${TEST_HCSI}`,
    '@type': 'Person',
    additionalType: 'https://humanconsent.org/schemas/identity',
    name: 'Test Subject',
    description: 'Fictional person created for Grantmark tests.',
    identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://personas.grantmark.example/test-subject' }],
  });
  return (
    `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"><hcs:right registry="${registry}" registration-id="${hcrn}" ` +
    `issued="2026-09-01T00:00:00Z" subject="identity" subject-id="${TEST_HCSI}" ${attributes}>` +
    `<schema type="application/ld+json">${schema}</schema>${licenses}</hcs:right></rsl>`
  );
}

beforeEach(() => {
  clock = new Date('2026-09-20T10:00:00Z');
  db = openDatabase(':memory:');
  services = createServices(db, config, () => clock);
  seedPersonas(services.registry, config);
  services.registry.putSubject({
    '@context': 'https://schema.org',
    '@id': `https://id.humanconsent.org/${TEST_HCSI}`,
    '@type': 'Person',
    additionalType: 'https://humanconsent.org/schemas/identity',
    name: 'Test Subject',
    description: 'Fictional person created for Grantmark tests.',
    birthDate: '1985-05-05',
    identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://personas.grantmark.example/test-subject' }],
  });
  services.registry.publish(testDeclaration(FREE_HCRN, `subject-scope="image likeness" server="${config.licenseServerUrl}"`, FREE_LICENSE));
  services.clients.create('Demo Studio', { clientId: CLIENT.id, secret: CLIENT.secret });
  app = createApp(services, config);
  clock = new Date('2026-10-01T12:00:00Z');
});

const basic = (id = CLIENT.id, secret = CLIENT.secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** `auth: null` sends no Authorization header. */
function post(path: string, form: Record<string, string>, auth: string | null = basic()) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth ? { authorization: auth } : {}) },
    body: new URLSearchParams(form).toString(),
  });
}

const token = (form: Record<string, string>) => post('/olp/token', { grant_type: 'client_credentials', ...form });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** The <license> element of an offer, exactly as it appears in the stored declaration. */
function offerOf(hcrn: string, index = 0): string {
  const xml = new TextDecoder().decode(services.registry.declaration(hcrn)!.content);
  return [...xml.matchAll(/<license>[\s\S]*?<\/license>/g)][index]![0];
}

describe('OLP authentication (RSL §5.3)', () => {
  it('requires HTTP Basic client credentials on every endpoint', async () => {
    for (const path of ['/olp/token', '/olp/introspect', '/olp/key']) {
      const response = await post(path, {}, null);
      expect(response.status, path).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Basic /);
      expect(await json(response)).toMatchObject({ error: 'invalid_client' });
    }
  });

  it('rejects a wrong secret', async () => {
    const response = await post('/olp/token', { grant_type: 'client_credentials' }, basic(CLIENT.id, 'wrong'));
    expect(response.status).toBe(401);
  });
});

describe('POST /olp/token: request checks (RSL §5.4)', () => {
  it('requires a form-encoded body', async () => {
    const response = await app.request('/olp/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic() },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
  });

  it.each([
    ['an unsupported grant type', { grant_type: 'password', license: FREE_LICENSE, resource: FREE_HCRN }, 'unsupported_grant_type'],
    ['a missing license', { grant_type: 'client_credentials', resource: FREE_HCRN }, 'invalid_request'],
    ['a missing resource', { grant_type: 'client_credentials', license: FREE_LICENSE }, 'invalid_request'],
    ['another license_type', { grant_type: 'client_credentials', license: FREE_LICENSE, resource: FREE_HCRN, license_type: 'application/json' }, 'invalid_license'],
    ['a resource that is not an HCRN', { grant_type: 'client_credentials', license: FREE_LICENSE, resource: 'https://example.com/a' }, 'invalid_resource'],
    ['an unknown HCRN', { grant_type: 'client_credentials', license: FREE_LICENSE, resource: 'HCRN-0000-00ZZ-R' }, 'invalid_resource'],
    ['a license that is not XML', { grant_type: 'client_credentials', license: 'free please', resource: FREE_HCRN }, 'invalid_license'],
    ['a license that matches no offer', { grant_type: 'client_credentials', license: FREE_LICENSE.replace('generate', 'train'), resource: FREE_HCRN }, 'invalid_license'],
    ['an invalid place', { grant_type: 'client_credentials', license: FREE_LICENSE, resource: FREE_HCRN, place: 'XK' }, 'invalid_request'],
    ['a scope the declaration does not cover', { grant_type: 'client_credentials', license: FREE_LICENSE, resource: FREE_HCRN, scope: 'voice' }, 'invalid_request'],
  ])('rejects %s', async (_label, form, error) => {
    const response = await post('/olp/token', form as Record<string, string>);
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error });
  });

  it('rejects a declaration that names another license server (HCS §3.1.10)', async () => {
    services.registry.publish(testDeclaration('HCRN-0000-006F-P', 'server="https://other-license-server.example/olp"', FREE_LICENSE));
    const response = await token({ license: FREE_LICENSE, resource: 'HCRN-0000-006F-P' });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_resource' });
  });
});

describe('POST /olp/token: a free license', () => {
  it('issues a License token that verifies against the published JWKS', async () => {
    const response = await token({ license: FREE_LICENSE, resource: FREE_HCRN });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await json(response);
    expect(body).toMatchObject({ token_type: 'License', expires_in: 30 * 24 * 60 * 60, subject_scope: 'image likeness' });
    expect(body.license_id).toMatch(/^lic_/);

    const jwks = (await (await app.request('/.well-known/jwks.json')).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(String(body.access_token), createLocalJWKSet(jwks), {
      issuer: config.licenseServerUrl,
      currentDate: clock,
    });
    expect(payload).toMatchObject({
      sub: CLIENT.id,
      jti: body.license_id,
      hcrn: FREE_HCRN,
      hcsi: TEST_HCSI,
      usage: ['hcs:ai-generate'],
      subject_scope: ['image', 'likeness'],
      declaration_sha256: services.registry.declaration(FREE_HCRN)!.sha256,
    });
    expect(services.licenses.license(String(body.license_id))).toMatchObject({ clientId: CLIENT.id, hcrn: FREE_HCRN, status: 'active' });
  });

  it('issues a license for an offer written with a prefix declared on an ancestor element', async () => {
    const prefixed = testDeclaration(FREE_HCRN, `subject-scope="image likeness" server="${config.licenseServerUrl}"`, FREE_LICENSE)
      .replace(`<rsl xmlns="${RSL_NAMESPACE}"`, `<r:rsl xmlns:r="${RSL_NAMESPACE}"`)
      .replace('</rsl>', '</r:rsl>')
      .replace(/<(\/?)(schema|license|permits|legal)\b/g, '<$1r:$2');
    clock = new Date('2026-09-25T10:00:00Z');
    services.registry.publish(prefixed);
    clock = new Date('2026-10-01T12:00:00Z');
    const response = await token({ license: FREE_LICENSE, resource: FREE_HCRN });
    expect(response.status).toBe(200);
  });

  it('accepts the canonical HCRN URI as resource and the offer in any order or spacing', async () => {
    const reordered = `<license>\n ${LEGAL}\n <permits type="usage"> hcs:ai-generate </permits></license>`;
    const response = await token({ license: reordered, resource: `https://id.humanconsent.org/${FREE_HCRN}` });
    expect(response.status).toBe(200);
  });

  it('narrows the license to the requested scopes', async () => {
    const body = await json(await token({ license: FREE_LICENSE, resource: FREE_HCRN, scope: 'image' }));
    expect(body.subject_scope).toBe('image');
  });

  it('never lasts beyond valid-until', async () => {
    services.registry.publish(
      testDeclaration('HCRN-0000-006F-P', `valid-until="2026-10-05T12:00:00Z" server="${config.licenseServerUrl}"`, FREE_LICENSE),
    );
    const body = await json(await token({ license: FREE_LICENSE, resource: 'HCRN-0000-006F-P' }));
    expect(body.expires_in).toBe(4 * 24 * 60 * 60);
  });

  it('licenses only the scopes that are not in conflict, and says why', async () => {
    services.registry.publish(
      testDeclaration('HCRN-0000-006F-P', 'subject-scope="likeness"', `<license><prohibits type="usage">hcs:ai-generate</prohibits>${LEGAL}</license>`, 'https://registry.harbor-agency.example'),
    );
    const response = await token({ license: FREE_LICENSE, resource: FREE_HCRN });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.subject_scope).toBe('image');
    expect(String((body.excluded_scope as Record<string, string>).likeness)).toMatch(/conflict/i);
  });

  it('needs a place of use when the declaration is limited to a territory', async () => {
    services.registry.publish(testDeclaration('HCRN-0000-006F-P', `territory="US" server="${config.licenseServerUrl}"`, FREE_LICENSE));
    const form = { license: FREE_LICENSE, resource: 'HCRN-0000-006F-P' };
    expect((await token(form)).status).toBe(403);
    expect((await token({ ...form, place: 'US' })).status).toBe(200);
    expect((await token({ ...form, place: 'FR' })).status).toBe(403);
  });
});

describe('POST /olp/token: refusals and payment', () => {
  it('asks for payment before issuing a paid license (Grantmark extension)', async () => {
    const response = await token({ license: offerOf('HCRN-0000-0068-F'), resource: 'HCRN-0000-0068-F', scope: 'image' });
    expect(response.status).toBe(402);
    const body = await json(response);
    expect(body).toMatchObject({
      error: 'payment_required',
      payment: { status: 'requires_payment', amount: { value: '5.00', currency: 'USD' } },
    });
    const id = String((body.payment as Record<string, unknown>).license_request);
    expect(services.licenses.request(id)).toMatchObject({ state: 'requires_payment', hcrn: 'HCRN-0000-0068-F', subjectScope: ['image'] });
  });

  it('refuses a minor before any payment request exists (HCS §1.1)', async () => {
    const response = await token({ license: offerOf('HCRN-0000-006A-H'), resource: 'HCRN-0000-006A-H' });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'invalid_license', reason_code: 'minor_protection' });
    expect(services.licenses.requestCount()).toBe(0);
  });

  it('refuses a minor even when an unrelated Default Declaration was published first', async () => {
    const bookClass = `${config.registryId}/classes/books`;
    const unrelated =
      `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"><hcs:right registry="${config.registryId}" ` +
      `registration-id="HCRN-0000-006F-P" issued="2026-09-01T00:00:00Z" subject="work" subject-scope="literary" ` +
      `subject-class="${bookClass}"><schema type="application/ld+json">` +
      JSON.stringify({
        '@context': 'https://schema.org',
        '@id': bookClass,
        '@type': 'Collection',
        additionalType: 'https://humanconsent.org/schemas/book',
        name: 'Fictional books',
        description: 'Fictional books used in Grantmark tests.',
      }) +
      `</schema><license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license></hcs:right></rsl>`;
    clock = new Date('2026-09-20T10:00:00Z');
    services = createServices(openDatabase(':memory:'), config, () => clock);
    services.registry.putRegistry({ url: config.registryId, name: 'Grantmark test registry (mock)', authorized: true });
    services.registry.publish(unrelated);
    seedPersonas(services.registry, config);
    services.clients.create('Demo Studio', { clientId: CLIENT.id, secret: CLIENT.secret });
    app = createApp(services, config);
    clock = new Date('2026-10-01T12:00:00Z');

    const response = await token({ license: offerOf('HCRN-0000-006A-H'), resource: 'HCRN-0000-006A-H' });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'invalid_license', reason_code: 'minor_protection' });
    expect(services.licenses.requestCount()).toBe(0);
  });

  it('refuses a withdrawn declaration', async () => {
    const response = await token({ license: offerOf('HCRN-0000-006D-M'), resource: 'HCRN-0000-006D-M' });
    expect(response.status).toBe(403);
    const body = await json(response);
    expect(body).toMatchObject({ error: 'invalid_license', reason_code: 'not_operative' });
    expect(String(body.error_description)).toMatch(/withdrawn/);
  });

  it.each([
    ['a negative price', '-5.00'],
    ['a price finer than USDC can pay', '0.0000001'],
  ])('refuses %s instead of issuing a free license', async (_, amount) => {
    const priced = FREE_LICENSE.replace('</permits>', `</permits><payment type="purchase"><amount currency="USD">${amount}</amount></payment>`);
    clock = new Date('2026-09-25T10:00:00Z');
    services.registry.publish(testDeclaration(FREE_HCRN, `subject-scope="image likeness" server="${config.licenseServerUrl}"`, priced));
    clock = new Date('2026-10-01T12:00:00Z');
    const response = await token({ license: priced, resource: FREE_HCRN });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'invalid_license', reason_code: 'unsupported_terms' });
    expect(services.licenses.requestCount()).toBe(0);
  });

  it('refuses a license that permits nothing', async () => {
    const response = await token({ license: offerOf('HCRN-0000-0069-G'), resource: 'HCRN-0000-0069-G', place: 'DE' });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'invalid_license', reason_code: 'not_permitted' });
  });

  it('re-checks minors when a stored request is issued', async () => {
    const request = services.licenses.createRequest({
      clientId: CLIENT.id,
      hcrn: 'HCRN-0000-006A-H',
      hcsi: 'HCSI-0000-0036-W',
      declarationSha256: services.registry.declaration('HCRN-0000-006A-H')!.sha256,
      licenseXml: offerOf('HCRN-0000-006A-H'),
      licenseCanonical: canonicalLicense(offerOf('HCRN-0000-006A-H'))!,
      licenseIndex: 1,
      usage: ['hcs:ai-generate'],
      subjectScope: ['image'],
      amount: { value: '3.00', currency: 'USD' },
    });
    const outcome = await services.licensing.issue(request.id);
    expect(outcome).toMatchObject({ kind: 'error', reasonCode: 'minor_protection' });
    expect(services.licenses.licenseForRequest(request.id)).toBeUndefined();
  });
});

describe('issuing again for a request that already has a license', () => {
  async function freeLicense() {
    const body = await json(await token({ license: FREE_LICENSE, resource: FREE_HCRN }));
    return services.licenses.license(String(body.license_id))!;
  }

  it('hands out a new token while the license still permits new uses', async () => {
    const license = await freeLicense();
    expect(await services.licensing.issue(license.requestId)).toMatchObject({ kind: 'token', license: { id: license.id } });
  });

  it('refuses once the declaration is withdrawn', async () => {
    const license = await freeLicense();
    clock = new Date('2026-10-02T12:00:00Z');
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(current.replace('subject="identity"', 'subject="identity" status="withdrawn"'));
    clock = new Date('2026-10-03T12:00:00Z');
    expect(await services.licensing.issue(license.requestId)).toMatchObject({ kind: 'error', reasonCode: 'not_operative' });
  });

  it('refuses a revoked license', async () => {
    const license = await freeLicense();
    db.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").run(license.id);
    expect(await services.licensing.issue(license.requestId)).toMatchObject({ kind: 'error', error: 'invalid_license' });
  });
});

describe('POST /olp/introspect (RSL §5.5)', () => {
  async function freeToken(): Promise<string> {
    return String((await json(await token({ license: FREE_LICENSE, resource: FREE_HCRN }))).access_token);
  }

  it('describes an active token for its resource', async () => {
    const access = await freeToken();
    const body = await json(await post('/olp/introspect', { token: access, resource: FREE_HCRN }));
    expect(body).toMatchObject({
      active: true,
      token_type: 'License',
      license: FREE_LICENSE,
      resource: FREE_HCRN,
      permitted: true,
      hcrn: FREE_HCRN,
      client_id: CLIENT.id,
    });
    expect(body.license_id).toMatch(/^lic_/);
  });

  it('is not permitted for another resource', async () => {
    const body = await json(await post('/olp/introspect', { token: await freeToken(), resource: 'HCRN-0000-0068-F' }));
    expect(body).toMatchObject({ active: true, permitted: false });
    expect(String(body.reason)).toMatch(/does not cover/);
  });

  it('is not permitted for new uses after the declaration is withdrawn (HCS §1.3)', async () => {
    const access = await freeToken();
    clock = new Date('2026-10-02T12:00:00Z');
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(current.replace('subject="identity"', 'subject="identity" status="withdrawn"'));
    clock = new Date('2026-10-03T12:00:00Z');
    const body = await json(await post('/olp/introspect', { token: access, resource: FREE_HCRN }));
    expect(body).toMatchObject({ active: true, permitted: false });
    expect(String(body.reason)).toMatch(/withdrawn/);
  });

  it('is not permitted for new uses once the licensed offer is no longer in the declaration', async () => {
    const access = await freeToken();
    clock = new Date('2026-10-02T12:00:00Z');
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(
      current.replace('</permits>', '</permits><payment type="purchase"><amount currency="USD">1.00</amount></payment>'),
    );
    clock = new Date('2026-10-03T12:00:00Z');
    const body = await json(await post('/olp/introspect', { token: access, resource: FREE_HCRN }));
    expect(body).toMatchObject({ active: true, permitted: false });
    expect(String(body.reason)).toMatch(/no longer offered/);
  });

  it('reports expired and unknown tokens as inactive', async () => {
    const access = await freeToken();
    clock = new Date(clock.getTime() + 31 * DAY);
    expect(await json(await post('/olp/introspect', { token: access, resource: FREE_HCRN }))).toEqual({ active: false });
    expect(await json(await post('/olp/introspect', { token: 'not-a-token', resource: FREE_HCRN }))).toEqual({ active: false });
  });

  it('requires token and resource', async () => {
    const response = await post('/olp/introspect', { resource: FREE_HCRN });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
  });
});

describe('POST /olp/key and GET /.well-known/jwks.json', () => {
  it('does not serve EMS keys', async () => {
    const response = await app.request('/olp/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic() },
      body: JSON.stringify({ token: 'x', resource: 'y' }),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
  });

  it('publishes the token signing keys', async () => {
    const body = (await (await app.request('/.well-known/jwks.json')).json()) as JSONWebKeySet;
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ alg: 'ES256', use: 'sig' });
  });
});
