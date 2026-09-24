import { DEVNET_GENESIS_HASH, type ParsedTransaction, type SolanaRpc } from '@grantmark/payments';
import { parsedTransactionFor } from '@grantmark/payments/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createServices, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const config = loadConfig({ PUBLIC_BASE_URL: 'https://grantmark.test', REGISTRY_ID: 'https://grantmark.test/registry', LICENSE_SERVER_URL: 'https://grantmark.test/olp' });
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';
/** The random value a browser keeps for its own demo payments. */
const CLAIM = 'c1a1m-0f-th1s-br0wser-7f3a9c';
const MIRA = 'HCRN-0000-0068-F';

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

beforeEach(() => {
  clock = new Date('2026-09-20T10:00:00Z');
  rpc = new FakeRpc();
  services = createServices(openDatabase(':memory:'), config, () => clock, { solanaRpc: rpc });
  seedPersonas(services.registry, config);
  services.payees.setRightsHolderWallet(MIRA, '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza');
  services.clients.create('Demo Studio (fictional)', { clientId: 'demo-studio', secret: 'demo-studio-secret-value' });
  app = createApp(services, config);
  clock = new Date('2026-10-01T12:00:00Z');
});

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const postJson = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('GET /v1/demo/personas', () => {
  it('lists the fictional personas with their declarations and age status', async () => {
    const response = await app.request('/v1/demo/personas');
    expect(response.status).toBe(200);
    const { personas } = await json(response);
    expect(personas.map((p: any) => p.name)).toEqual(['Arden Holt', 'Lina Sorel', 'Mira Vale', 'Noor Castell', 'Tomas Reyka']);
    const mira = personas.find((p: any) => p.name === 'Mira Vale');
    expect(mira).toMatchObject({
      hcsi: 'HCSI-0000-0034-T',
      age_status: 'adult',
      fictional: true,
      declarations: [
        {
          hcrn: MIRA,
          registry: config.registryId,
          status: 'active',
          subject_scope: ['image', 'likeness'],
          url: `https://grantmark.test/registry/declarations/${MIRA}`,
          offers: [
            { license: 1, usage: ['hcs:ai-generate'], user: ['commercial'], amount: { value: '5.00', currency: 'USD' } },
            { license: 2, usage: ['hcs:ai-generate'], user: ['non-commercial', 'personal'], amount: { value: '1.00', currency: 'USD' } },
          ],
        },
      ],
    });
    expect(personas.find((p: any) => p.name === 'Lina Sorel').age_status).toBe('minor');
    expect(personas.find((p: any) => p.name === 'Arden Holt').declarations).toHaveLength(2);
  });
});

describe('POST /v1/evaluate', () => {
  it('evaluates a subject for a use', async () => {
    const response = await postJson('/v1/evaluate', { subject: 'HCSI-0000-0034-T', usage: 'hcs:ai-generate', scopes: ['image'] });
    expect(response.status).toBe(200);
    const evaluation = await json(response);
    expect(evaluation).toMatchObject({ usage: 'hcs:ai-generate', decision: 'permitted_with_terms', minorProtectionApplied: false, ageStatus: 'adult' });
    expect(evaluation.offers).toHaveLength(2);
    expect(typeof evaluation.declarations[0].revalidateBy).toBe('string');
  });

  it('evaluates the subject of a declaration, defaulting to its scopes', async () => {
    const evaluation = await json(await postJson('/v1/evaluate', { hcrn: 'HCRN-0000-006B-J' }));
    expect(evaluation.scopes.map((s: any) => [s.scope, s.decision])).toEqual([
      ['image', 'permitted_with_terms'],
      ['likeness', 'prohibited'],
    ]);
  });

  it('checks a pasted declaration for conformance', async () => {
    const xml = new TextDecoder().decode(services.registry.declaration(MIRA)!.content).replace('<legal type="attestation">true</legal>', '');
    const result = await json(await postJson('/v1/evaluate', { xml }));
    expect(result.declarations[0].reasons.map((r: any) => r.code)).toEqual(['legal_attestation']);
  });

  it.each([
    ['an unknown usage token', { subject: 'HCSI-0000-0034-T', usage: 'ai-train' }],
    ['an invalid HCSI', { subject: 'HCSI-0000-0034-X' }],
    ['nothing to evaluate', {}],
    ['an unknown HCRN', { hcrn: 'HCRN-0000-00ZZ-R' }],
    ['an invalid place', { subject: 'HCSI-0000-0034-T', place: 'XK' }],
  ])('rejects %s', async (_label, body) => {
    expect((await postJson('/v1/evaluate', body)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /v1/demo/licenses (the demo studio, server side)', () => {
  it('asks for payment, then issues the license once paid', async () => {
    const first = await postJson('/v1/demo/licenses', { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER, claim: CLAIM });
    expect(first.status).toBe(402);
    const { payment } = await json(first);
    expect(payment.accepts[0].transaction.length).toBeGreaterThan(100);

    rpc.finalized.set(SIGNATURE, parsedTransactionFor(services.payments.get(payment.id)!.request, { signature: SIGNATURE, paidAt: new Date(clock.getTime() + 5000) }));
    const paid = await postJson('/v1/demo/licenses', { hcrn: MIRA, license: 1, scope: 'image', payment_id: payment.id, payment_evidence: SIGNATURE, claim: CLAIM });
    expect(paid.status).toBe(200);
    const body = await json(paid);
    expect(body).toMatchObject({ token_type: 'License', subject_scope: 'image' });
    expect(services.licenses.license(body.license_id)?.clientId).toBe('demo-studio');
  });

  it("does not let another browser settle a payment it did not start (the demo client is shared)", async () => {
    const first = await postJson('/v1/demo/licenses', { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER, claim: CLAIM });
    const { payment } = await json(first);
    rpc.finalized.set(SIGNATURE, parsedTransactionFor(services.payments.get(payment.id)!.request, { signature: SIGNATURE, paidAt: new Date(clock.getTime() + 5000) }));
    const settle = (claim?: string) =>
      postJson('/v1/demo/licenses', { hcrn: MIRA, license: 1, scope: 'image', payment_id: payment.id, payment_evidence: SIGNATURE, ...(claim === undefined ? {} : { claim }) });

    expect((await settle('another-browser-claim-4b1e')).status).toBe(400);
    expect((await settle()).status).toBe(400);
    expect(services.payments.get(payment.id)?.status).toBe('requires_payment');
    expect((await settle(CLAIM)).status).toBe(200);
    // Once settled, the payment id from the public receipt still gives nobody else a token.
    expect((await settle('another-browser-claim-4b1e')).status).toBe(400);
  });

  it('requires a claim before it starts a payment', async () => {
    const response = await postJson('/v1/demo/licenses', { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
    expect(services.payments.open()).toEqual([]);
  });

  it('refuses a minor exactly like /olp/token', async () => {
    const response = await postJson('/v1/demo/licenses', { hcrn: 'HCRN-0000-006A-H', license: 1, payer: PAYER, claim: CLAIM });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ reason_code: 'minor_protection' });
  });

  it('rejects an offer number the declaration does not have', async () => {
    expect((await postJson('/v1/demo/licenses', { hcrn: MIRA, license: 3 })).status).toBe(400);
  });

  it('is unavailable when the demo client does not exist', async () => {
    const bare = createServices(openDatabase(':memory:'), config, () => clock, { solanaRpc: rpc });
    seedPersonas(bare.registry, config);
    const response = await createApp(bare, config).request('/v1/demo/licenses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hcrn: MIRA, license: 1 }),
    });
    expect(response.status).toBe(503);
  });
});
