import { createHash } from 'node:crypto';
import { HCS_NAMESPACE, RSL_NAMESPACE } from '@grantmark/hcs';
import { DEVNET_GENESIS_HASH, type ParsedTransaction, type SolanaRpc } from '@grantmark/payments';
import { parsedTransactionFor } from '@grantmark/payments/testing';
import { Stamper, loadTestPki, placeholderPng } from '@grantmark/stamp';
import { crc32 } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createServices, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const BASE = 'https://grantmark.test';
const config = loadConfig({ PUBLIC_BASE_URL: BASE, REGISTRY_ID: 'https://grantmark.test/registry', LICENSE_SERVER_URL: 'https://grantmark.test/olp' });
const TEST_HCSI = 'HCSI-0000-0039-Z';
const FREE_HCRN = 'HCRN-0000-006E-N';
const MIRA = 'HCRN-0000-0068-F';
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
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

const person = {
  '@context': 'https://schema.org',
  '@id': `https://id.humanconsent.org/${TEST_HCSI}`,
  '@type': 'Person',
  additionalType: 'https://humanconsent.org/schemas/identity',
  name: 'Test Subject',
  description: 'Fictional person created for Grantmark tests.',
  identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://personas.grantmark.example/test-subject' }],
};

let clock: Date;
let rpc: FakeRpc;
let services: Services;
let app: ReturnType<typeof createApp>;

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
  services.payees.setRightsHolderWallet(MIRA, '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza');
  services.clients.create('Demo Studio', { clientId: 'demo-studio', secret: 'demo-studio-secret-value' });
  app = createApp(services, config);
  clock = new Date('2026-10-01T12:00:00Z');
});

const basic = `Basic ${Buffer.from('demo-studio:demo-studio-secret-value').toString('base64')}`;
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const tokenRequest = (form: Record<string, string>) =>
  app.request('/olp/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...form }).toString(),
  });

async function freeLicense() {
  const body = await json(await tokenRequest({ license: FREE_LICENSE, resource: FREE_HCRN }));
  return { id: String(body.license_id), token: String(body.access_token) };
}

async function paidLicense() {
  const offer = new TextDecoder().decode(services.registry.declaration(MIRA)!.content).match(/<license>[\s\S]*?<\/license>/)![0];
  const form = { license: offer, resource: MIRA, scope: 'image' };
  const { payment } = await json(await tokenRequest({ ...form, payer: PAYER }));
  rpc.finalized.set(SIGNATURE, parsedTransactionFor(services.payments.get(payment.id)!.request, { signature: SIGNATURE, paidAt: new Date(clock.getTime() + 5_000) }));
  const body = await json(await tokenRequest({ ...form, payment_id: payment.id, payment_evidence: SIGNATURE }));
  return { id: String(body.license_id), token: String(body.access_token) };
}

async function stamped(license: { id: string; token: string }, mode?: 'sidecar') {
  const image = placeholderPng(64, 48, 5);
  const form = new FormData();
  form.set('image', new File([image], 'generated.png', { type: 'image/png' }));
  if (mode) form.set('mode', mode);
  const response = await app.request(`/v1/licenses/${license.id}/stamp`, { method: 'POST', headers: { authorization: `License ${license.token}` }, body: form });
  return { original: image, output: new Uint8Array(await response.arrayBuffer()) };
}

function verify(image: Uint8Array, manifest?: Uint8Array) {
  const form = new FormData();
  form.set('image', new File([image], 'check.png', { type: 'image/png' }));
  if (manifest) form.set('manifest', new File([manifest], 'check.c2pa', { type: 'application/c2pa' }));
  return app.request('/v1/verify', { method: 'POST', body: form });
}

function tamper(png: Uint8Array): Uint8Array {
  const copy = new Uint8Array(png);
  const view = new DataView(copy.buffer);
  for (let offset = 8; offset < copy.length; ) {
    const length = view.getUint32(offset);
    if (new TextDecoder().decode(copy.subarray(offset + 4, offset + 8)) === 'IDAT') {
      const target = offset + 8 + length - 5;
      copy[target] = copy[target]! ^ 0xff;
      view.setUint32(offset + 8 + length, crc32(copy.subarray(offset + 4, offset + 8 + length)));
      return copy;
    }
    offset += 12 + length;
  }
  throw new Error('no IDAT');
}

describe('POST /v1/verify', () => {
  it('confirms a stamped image under an active license', async () => {
    const license = await freeLicense();
    const { output } = await stamped(license);
    const response = await verify(output);
    expect(response.status).toBe(200);
    const result = await json(response);
    expect(result).toMatchObject({
      verdict: { status: 'licensed' },
      manifest: { found: true, embedded: true, validation_state: 'Trusted', trusted: true, trust: 'Trusted (test PKI)', failures: [] },
      asset: { sha256: createHash('sha256').update(output).digest('hex'), registered: true, licenses: [license.id] },
      license: { license_id: license.id, status: 'active', current_permission: { permitted: true } },
      receipt: { present: true, valid: true, matches_license: true },
      payment: { on_chain: 'none' },
    });
    expect(result.consent_references[0].uri).toBe(`${BASE}/v1/licenses/${license.id}`);
    expect(result.verdict.warnings).toEqual([]);
  });

  it('re-checks the payment on devnet for a paid license', async () => {
    const { output } = await stamped(await paidLicense());
    const result = await json(await verify(output));
    expect(result.verdict.status).toBe('licensed');
    expect(result.payment).toMatchObject({
      on_chain: 'verified',
      transaction_signature: SIGNATURE,
      explorer_url: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    });
  });

  it('warns when the payment cannot be found on-chain any more', async () => {
    const { output } = await stamped(await paidLicense());
    rpc.finalized.clear();
    const result = await json(await verify(output));
    expect(result.payment.on_chain).toBe('not_found');
    expect(result.verdict.status).toBe('licensed');
    expect(result.verdict.warnings.join(' ')).toMatch(/payment/i);
  });

  it('verifies a sidecar manifest against the unchanged image', async () => {
    const { original, output } = await stamped(await freeLicense(), 'sidecar');
    const result = await json(await verify(original, output));
    expect(result.verdict.status).toBe('licensed');
    expect(result.manifest.embedded).toBe(false);
  });

  it('reports a change after stamping', async () => {
    const { output } = await stamped(await freeLicense());
    const result = await json(await verify(tamper(output)));
    expect(result.verdict.status).toBe('tampered');
    expect(result.asset.registered).toBe(false);
  });

  it('reports an image without Content Credentials', async () => {
    const result = await json(await verify(placeholderPng(32, 32, 9)));
    expect(result.verdict.status).toBe('no_credentials');
    expect(result.license).toBeNull();
  });

  it('says a license was valid when stamped but new uses are no longer permitted after a withdrawal', async () => {
    const { output } = await stamped(await freeLicense());
    const current = new TextDecoder().decode(services.registry.declaration(FREE_HCRN)!.content);
    services.registry.publish(current.replace('subject="identity"', 'subject="identity" status="withdrawn"'));
    clock = new Date(clock.getTime() + 60_000);
    const result = await json(await verify(output));
    expect(result.verdict.status).toBe('licensed_before_change');
    expect(result.verdict.summary).toMatch(/no longer/);
  });

  it('reports an expired license', async () => {
    const { output } = await stamped(await freeLicense());
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect((await json(await verify(output))).verdict.status).toBe('expired');
  });

  it('does not vouch for consent authorities other than this server', async () => {
    const foreign = await new Stamper(PKI).stamp({
      image: placeholderPng(32, 32, 6),
      mimeType: 'image/png',
      licenseUrl: 'https://other-authority.example/licenses/123',
    });
    const result = await json(await verify(foreign.image));
    expect(result.verdict.status).toBe('unknown_authority');
    expect(result.manifest.trusted).toBe(true);
  });

  it('warns about a receipt that does not verify', async () => {
    const license = await freeLicense();
    const forged = await new Stamper(PKI).stamp({
      image: placeholderPng(32, 32, 7),
      mimeType: 'image/png',
      licenseUrl: `${BASE}/v1/licenses/${license.id}`,
      receipt: 'eyJhbGciOiJub25lIn0.e30.',
    });
    const result = await json(await verify(forged.image));
    expect(result.receipt).toMatchObject({ present: true, valid: false });
    expect(result.verdict.warnings.join(' ')).toMatch(/receipt/i);
  });

  it('requires an image', async () => {
    const response = await app.request('/v1/verify', { method: 'POST', body: new FormData() });
    expect(response.status).toBe(400);
  });
});

describe('GET /v1/verify?license=', () => {
  it('checks a license by id: record, receipt and on-chain payment', async () => {
    const license = await paidLicense();
    const result = await json(await app.request(`/v1/verify?license=${license.id}`));
    expect(result).toMatchObject({
      verdict: { status: 'licensed' },
      license: { license_id: license.id },
      receipt: { present: true, valid: true },
      payment: { on_chain: 'verified' },
    });
  });

  it('answers 404 for an unknown license', async () => {
    expect((await app.request('/v1/verify?license=lic_UNKNOWN')).status).toBe(404);
  });
});
