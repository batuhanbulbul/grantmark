import { createHash } from 'node:crypto';
import { HCS_NAMESPACE, RSL_NAMESPACE } from '@grantmark/hcs';
import { DEVNET_GENESIS_HASH, commitmentMemo, type ParsedTransaction, type SolanaRpc } from '@grantmark/payments';
import { parsedTransactionFor } from '@grantmark/payments/testing';
import { loadTestPki, placeholderPng, readStamp } from '@grantmark/stamp';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createServices, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const BASE = 'https://grantmark.test';
const config = loadConfig({
  PUBLIC_BASE_URL: BASE,
  REGISTRY_ID: 'https://grantmark.test/registry',
  LICENSE_SERVER_URL: 'https://grantmark.test/olp',
});
const TEST_HCSI = 'HCSI-0000-0039-Z';
const FREE_HCRN = 'HCRN-0000-006E-N';
const MIRA = 'HCRN-0000-0068-F';
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const RIGHTS_HOLDER = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';
const LEGAL = '<legal type="attestation">true</legal><legal type="contact">mailto:rights@test-subject.example</legal>';
const FREE_LICENSE = `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`;
const PKI = loadTestPki();

class FakeRpc implements SolanaRpc {
  finalized = new Map<string, ParsedTransaction>();
  async getLatestBlockhash() {
    return { blockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 1000n };
  }
  async getTransaction(signature: string) {
    return this.finalized.get(signature) ?? null;
  }
  async getGenesisHash() {
    return DEVNET_GENESIS_HASH;
  }
  async getSignaturesForAddress() {
    return [];
  }
}

let clock: Date;
let rpc: FakeRpc;
let services: Services;
let app: ReturnType<typeof createApp>;

const person = {
  '@context': 'https://schema.org',
  '@id': `https://id.humanconsent.org/${TEST_HCSI}`,
  '@type': 'Person',
  additionalType: 'https://humanconsent.org/schemas/identity',
  name: 'Test Subject',
  description: 'Fictional person created for Grantmark tests.',
  identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://personas.grantmark.example/test-subject' }],
};

beforeEach(() => {
  clock = new Date('2026-09-20T10:00:00Z');
  rpc = new FakeRpc();
  services = createServices(openDatabase(':memory:'), config, () => clock, { solanaRpc: rpc, signing: PKI });
  seedPersonas(services.registry, config);
  services.registry.putSubject({ ...person, birthDate: '1985-05-05' });
  services.registry.publish(
    `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"><hcs:right registry="${config.registryId}" registration-id="${FREE_HCRN}" ` +
      `issued="2026-09-01T00:00:00Z" subject="identity" subject-scope="image likeness" subject-id="${TEST_HCSI}" server="${config.licenseServerUrl}">` +
      `<schema type="application/ld+json">${JSON.stringify(person)}</schema>${FREE_LICENSE}</hcs:right></rsl>`,
  );
  services.payees.setRightsHolderWallet(MIRA, RIGHTS_HOLDER);
  services.clients.create('Demo Studio', { clientId: 'demo-studio', secret: 'demo-studio-secret-value' });
  app = createApp(services, config);
  clock = new Date('2026-10-01T12:00:00Z');
});

const basic = `Basic ${Buffer.from('demo-studio:demo-studio-secret-value').toString('base64')}`;
const json = async (response: Response) => (await response.json()) as Record<string, any>;

async function freeLicense(): Promise<{ id: string; token: string }> {
  const response = await app.request('/olp/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: new URLSearchParams({ grant_type: 'client_credentials', license: FREE_LICENSE, resource: FREE_HCRN }).toString(),
  });
  const body = await json(response);
  return { id: String(body.license_id), token: String(body.access_token) };
}

async function paidLicense(): Promise<{ id: string; token: string }> {
  const offer = new TextDecoder().decode(services.registry.declaration(MIRA)!.content).match(/<license>[\s\S]*?<\/license>/)![0];
  const form = { grant_type: 'client_credentials', license: offer, resource: MIRA, scope: 'image' };
  const post = (extra: Record<string, string>) =>
    app.request('/olp/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: new URLSearchParams({ ...form, ...extra }).toString(),
    });
  const { payment } = await json(await post({ payer: PAYER }));
  const request = services.payments.get(payment.id)!.request;
  rpc.finalized.set(SIGNATURE, parsedTransactionFor(request, { signature: SIGNATURE, paidAt: new Date(clock.getTime() + 5_000) }));
  const body = await json(await post({ payment_id: payment.id, payment_evidence: SIGNATURE }));
  return { id: String(body.license_id), token: String(body.access_token) };
}

async function jwks(): Promise<JSONWebKeySet> {
  return (await (await app.request('/.well-known/jwks.json')).json()) as JSONWebKeySet;
}

function stamp(id: string, token: string | null, image: Uint8Array, type = 'image/png', mode?: string) {
  const form = new FormData();
  form.set('image', new File([image], 'generated.png', { type }));
  if (mode !== undefined) form.set('mode', mode);
  return app.request(`/v1/licenses/${id}/stamp`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `License ${token}` },
    body: form,
  });
}

describe('receipts', () => {
  it('signs a public receipt for every license, verifiable with the JWKS and without expiry', async () => {
    const { id } = await freeLicense();
    const response = await app.request(`/v1/licenses/${id}/receipt`);
    expect(response.status).toBe(200);
    const { receipt } = await json(response);
    expect(decodeProtectedHeader(receipt)).toMatchObject({ alg: 'ES256', typ: 'grantmark-receipt+jwt' });
    const { payload } = await jwtVerify(receipt, createLocalJWKSet(await jwks()), { issuer: config.licenseServerUrl, typ: 'grantmark-receipt+jwt' });
    expect(payload.exp).toBeUndefined();
    expect(payload).toMatchObject({
      jti: id,
      sub: 'demo-studio',
      license: { id, hcrn: FREE_HCRN, hcsi: TEST_HCSI, usage: ['hcs:ai-generate'], subject_scope: ['image', 'likeness'] },
    });
    expect(payload.payment).toBeUndefined();
  });

  it('binds a paid license to the on-chain payment and its commitment', async () => {
    const { id } = await paidLicense();
    const { receipt } = await json(await app.request(`/v1/licenses/${id}/receipt`));
    const { payload } = await jwtVerify(receipt, createLocalJWKSet(await jwks()), { typ: 'grantmark-receipt+jwt' });
    const payment = payload.payment as Record<string, any>;
    expect(payment).toMatchObject({
      provider: 'solana-usdc-devnet',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      transaction_signature: SIGNATURE,
      amount: { value: '5.00', currency: 'USD' },
    });
    expect(payment.memo).toBe(commitmentMemo(payment.commitment));
  });

  it('is not accepted as an access token', async () => {
    const { id } = await freeLicense();
    const { receipt } = await json(await app.request(`/v1/licenses/${id}/receipt`));
    const introspection = await app.request('/olp/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: new URLSearchParams({ token: receipt, resource: FREE_HCRN }).toString(),
    });
    expect(await json(introspection)).toEqual({ active: false });
    expect((await stamp(id, receipt, placeholderPng(32, 32, 1))).status).toBe(401);
  });
});

describe('GET /v1/licenses/:id (public license record)', () => {
  it('answers the CAWG minimum set for a consent authority', async () => {
    const { id } = await paidLicense();
    const response = await app.request(`/v1/licenses/${id}`);
    expect(response.status).toBe(200);
    const record = await json(response);
    expect(record).toMatchObject({
      license_id: id,
      status: 'active',
      current_permission: { permitted: true },
      declaring_party: {
        registry: config.registryId,
        hcrn: MIRA,
        declaration_url: `${BASE}/registry/declarations/${MIRA}`,
        rights_subject: { hcsi: 'HCSI-0000-0034-T', name: 'Mira Vale', record_url: `${BASE}/registry/subjects/HCSI-0000-0034-T` },
      },
      grant: { usage: ['hcs:ai-generate'], subject_scope: ['image'] },
      compensation: {
        amount: { value: '5.00', currency: 'USD' },
        payment: { transaction_signature: SIGNATURE, explorer_url: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet` },
      },
      term: { valid_from: '2026-10-01T12:00:00.000Z', valid_until: '2026-10-31T12:00:00.000Z' },
      binding: { subject: 'HCSI-0000-0034-T', assets: [] },
      receipt_url: `${BASE}/v1/licenses/${id}/receipt`,
    });
    expect(record.grant.license).toMatch(/^<license>/);
    expect(typeof record.revocability).toBe('string');
  });

  it('shows new uses as no longer permitted after a withdrawal, while the license stays on record', async () => {
    const { id } = await freeLicense();
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(current.replace('subject="identity"', 'subject="identity" status="withdrawn"'));
    clock = new Date(clock.getTime() + 60_000);
    const record = await json(await app.request(`/v1/licenses/${id}`));
    expect(record.status).toBe('active');
    expect(record.current_permission.permitted).toBe(false);
    expect(record.current_permission.reason).toMatch(/withdrawn/);
  });

  it('marks an expired license', async () => {
    const { id } = await freeLicense();
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect((await json(await app.request(`/v1/licenses/${id}`))).status).toBe('expired');
  });

  it('answers 404 for an unknown license', async () => {
    expect((await app.request('/v1/licenses/lic_UNKNOWN')).status).toBe(404);
    expect((await app.request('/v1/licenses/lic_UNKNOWN/receipt')).status).toBe(404);
  });
});

describe('POST /v1/licenses/:id/stamp', () => {
  it('returns the image with an embedded manifest that points at the license record', async () => {
    const { id, token } = await freeLicense();
    const response = await stamp(id, token, placeholderPng(64, 48, 3));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const stamped = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(stamped).digest('hex');
    expect(response.headers.get('x-grantmark-asset-sha256')).toBe(sha256);

    const reading = await readStamp({ image: stamped, mimeType: 'image/png', trustAnchors: PKI.trustAnchors });
    expect(reading).toMatchObject({ validationState: 'Trusted', embedded: true });
    expect(reading.consent.map((c) => c.uri)).toEqual([`${BASE}/v1/licenses/${id}`, `https://id.humanconsent.org/${FREE_HCRN}`]);
    expect(reading.receipt).toBe((await json(await app.request(`/v1/licenses/${id}/receipt`))).receipt);

    const record = await json(await app.request(`/v1/licenses/${id}`));
    expect(record.binding.assets).toEqual([{ sha256, mime: 'image/png', mode: 'embedded', stamped_at: clock.toISOString() }]);
  });

  it('returns a sidecar manifest and leaves the image unchanged', async () => {
    const { id, token } = await freeLicense();
    const image = placeholderPng(64, 48, 4);
    const response = await stamp(id, token, image, 'image/png', 'sidecar');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/c2pa');
    expect(response.headers.get('x-grantmark-asset-sha256')).toBe(createHash('sha256').update(image).digest('hex'));
    const manifest = new Uint8Array(await response.arrayBuffer());
    const reading = await readStamp({ image, mimeType: 'image/png', manifest, trustAnchors: PKI.trustAnchors });
    expect(reading).toMatchObject({ validationState: 'Trusted', embedded: false });
  });

  it('requires the License token of this license (RSL §6.2 License scheme)', async () => {
    const { id, token } = await freeLicense();
    const other = await freeLicense();
    const missing = await stamp(id, null, placeholderPng(32, 32, 1));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^License/);
    expect((await stamp(other.id, token, placeholderPng(32, 32, 1))).status).toBe(403);
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect((await stamp(id, token, placeholderPng(32, 32, 1))).status).toBe(401);
  });

  it('refuses after the declaration is withdrawn', async () => {
    const { id, token } = await freeLicense();
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(current.replace('subject="identity"', 'subject="identity" status="withdrawn"'));
    clock = new Date(clock.getTime() + 60_000);
    const response = await stamp(id, token, placeholderPng(32, 32, 1));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ reason_code: 'not_operative' });
  });

  it('refuses a minor even when a license exists (HCS §1.1)', async () => {
    const offer = new TextDecoder().decode(services.registry.declaration('HCRN-0000-006A-H')!.content).match(/<license>[\s\S]*?<\/license>/)![0];
    const request = services.licenses.createRequest({
      clientId: 'demo-studio',
      hcrn: 'HCRN-0000-006A-H',
      hcsi: 'HCSI-0000-0036-W',
      declarationSha256: services.registry.declaration('HCRN-0000-006A-H')!.sha256,
      licenseXml: offer,
      licenseIndex: 1,
      usage: ['hcs:ai-generate'],
      subjectScope: ['image'],
    });
    const license = services.licenses.issue(request.id, {
      validFrom: clock,
      validUntil: new Date(clock.getTime() + 86_400_000),
      usage: ['hcs:ai-generate'],
      subjectScope: ['image'],
      declarationSha256: request.declarationSha256,
    });
    const token = await services.keys.sign({ jti: license.id, sub: 'demo-studio' }, clock, license.validUntil);
    const response = await stamp(license.id, token, placeholderPng(32, 32, 1));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ reason_code: 'minor_protection' });
  });

  it('accepts only PNG, JPEG and WebP, up to 10 MB', async () => {
    const { id, token } = await freeLicense();
    expect((await stamp(id, token, new Uint8Array([1, 2, 3]), 'image/gif')).status).toBe(415);
    expect((await stamp(id, token, new Uint8Array(10 * 1024 * 1024 + 1), 'image/png')).status).toBe(413);
  });
});
