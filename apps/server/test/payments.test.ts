import { DEVNET_GENESIS_HASH, type ParsedTransaction, type SignatureInfo, type SolanaPaymentRequest, type SolanaRpc } from '@grantmark/payments';
import { parsedTransactionFor } from '@grantmark/payments/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createServices, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const OPERATOR = 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb';
const RIGHTS_HOLDER = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';
const OTHER_SIGNATURE = '2nswcx5mYMvEty8nZc7pAQ1QPnKACZyR7TJL9Mi1VRxMJQhG9BwvJnc69ZgdopQYNzPDsSkAoDqUzkKnSgVHn8rb';
const MIRA = 'HCRN-0000-0068-F';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://grantmark.test',
  REGISTRY_ID: 'https://grantmark.test/registry',
  LICENSE_SERVER_URL: 'https://grantmark.test/olp',
  OPERATOR_WALLET: OPERATOR,
});

class FakeRpc implements SolanaRpc {
  finalized = new Map<string, ParsedTransaction>();
  confirmed = new Map<string, ParsedTransaction>();
  history: SignatureInfo[] = [];
  blockhashes = 0;
  async getLatestBlockhash() {
    this.blockhashes++;
    return {
      blockhash: this.blockhashes === 1 ? DEVNET_GENESIS_HASH : '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn',
      lastValidBlockHeight: BigInt(1000 + this.blockhashes),
    };
  }
  async getTransaction(signature: string, commitment: 'confirmed' | 'finalized') {
    return (commitment === 'finalized' ? this.finalized : this.confirmed).get(signature) ?? null;
  }
  async getGenesisHash() {
    return DEVNET_GENESIS_HASH;
  }
  async getSignaturesForAddress() {
    return this.history;
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
  services.payees.setRightsHolderWallet(MIRA, RIGHTS_HOLDER);
  services.clients.create('Demo Studio', { clientId: 'demo-studio', secret: 'demo-studio-secret-value' });
  services.clients.create('Other Studio', { clientId: 'other-studio', secret: 'other-studio-secret-value' });
  app = createApp(services, config);
  clock = new Date('2026-10-01T12:00:00Z');
});

const basic = (id = 'demo-studio', secret = 'demo-studio-secret-value') => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const OTHER_CLIENT = basic('other-studio', 'other-studio-secret-value');

function offerOf(hcrn: string): string {
  const xml = new TextDecoder().decode(services.registry.declaration(hcrn)!.content);
  return xml.match(/<license>[\s\S]*?<\/license>/)![0];
}

function token(form: Record<string, string>, auth = basic()) {
  return app.request('/olp/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
    body: new URLSearchParams({ grant_type: 'client_credentials', license: offerOf(MIRA), resource: MIRA, scope: 'image', ...form }).toString(),
  });
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;

async function startPayment(): Promise<{ id: string; request: SolanaPaymentRequest }> {
  const body = await json(await token({ payer: PAYER }));
  const id = String(body.payment.id);
  return { id, request: services.payments.get(id)!.request };
}

function payOnChain(request: SolanaPaymentRequest, options: { underpay?: boolean; commitment?: 'confirmed' | 'finalized' } = {}) {
  const tx = parsedTransactionFor(request, { signature: SIGNATURE, paidAt: new Date(clock.getTime() + 5_000), underpay: options.underpay });
  rpc.confirmed.set(SIGNATURE, tx);
  if (options.commitment !== 'confirmed') rpc.finalized.set(SIGNATURE, tx);
  return tx;
}

describe('POST /olp/token: payment request (402, Grantmark extension)', () => {
  it('asks for the payer wallet before building a transaction', async () => {
    const response = await token({});
    expect(response.status).toBe(402);
    const body = await json(response);
    expect(body.error_description).toMatch(/payer/);
    expect(body.payment).toMatchObject({ status: 'requires_payment', accepts: [] });
    expect(body.payment.id).toBeUndefined();
  });

  it('returns an x402-shaped Solana devnet payment with the 90/10 split and an unsigned transaction', async () => {
    const response = await token({ payer: PAYER });
    expect(response.status).toBe(402);
    const { payment } = await json(response);
    expect(payment).toMatchObject({
      status: 'requires_payment',
      amount: { value: '5.00', currency: 'USD' },
      expires_at: '2026-10-01T12:10:00.000Z',
    });
    expect(payment.id).toMatch(/^pay_/);
    expect(payment.license_request).toMatch(/^lrq_/);
    expect(payment.accepts).toHaveLength(1);
    expect(payment.accepts[0]).toMatchObject({
      provider: 'solana-usdc-devnet',
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      amount: '5000000',
      pay_to: [
        { role: 'rights_holder', wallet: RIGHTS_HOLDER, token_account: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3', amount: '4500000' },
        { role: 'operator_fee', wallet: OPERATOR, token_account: expect.any(String), amount: '500000' },
      ],
      max_timeout_seconds: 600,
    });
    expect(payment.accepts[0].memo).toMatch(/^gm1:/);
    expect(payment.accepts[0].transaction.length).toBeGreaterThan(100);
  });

  it('rejects an invalid payer wallet', async () => {
    const response = await token({ payer: 'not-a-wallet' });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses when the rights holder has no payee wallet', async () => {
    const response = await token({ payer: PAYER, license: offerOf('HCRN-0000-006B-J'), resource: 'HCRN-0000-006B-J' });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'invalid_license', reason_code: 'payment_unavailable' });
  });
});

describe('POST /olp/token: retry with payment evidence', () => {
  it('issues the license once the payment is finalized on devnet', async () => {
    const { id, request } = await startPayment();
    payOnChain(request);
    const response = await token({ payment_id: id, payment_evidence: SIGNATURE });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ token_type: 'License', subject_scope: 'image' });

    const payment = services.payments.get(id)!;
    expect(payment).toMatchObject({ status: 'succeeded', externalRef: SIGNATURE });
    expect(payment.receipt).toMatchObject({ externalRef: SIGNATURE, finality: 'finalized', testMode: true });
    expect(services.licenses.request(request.licenseRequestId)?.state).toBe('licensed');
    expect(services.licenses.license(body.license_id)?.hcrn).toBe(MIRA);
  });

  it('is idempotent: retrying returns the same license', async () => {
    const { id, request } = await startPayment();
    payOnChain(request);
    const first = await json(await token({ payment_id: id, payment_evidence: SIGNATURE }));
    const second = await json(await token({ payment_id: id, payment_evidence: SIGNATURE }));
    expect(second.license_id).toBe(first.license_id);
  });

  it('keeps asking while the transaction is only confirmed or not visible yet', async () => {
    const { id, request } = await startPayment();
    const missing = await token({ payment_id: id, payment_evidence: SIGNATURE });
    expect(missing.status).toBe(402);
    expect((await json(missing)).payment).toMatchObject({ id, status: 'requires_payment' });

    payOnChain(request, { commitment: 'confirmed' });
    const confirmed = await token({ payment_id: id, payment_evidence: SIGNATURE });
    expect(confirmed.status).toBe(402);
    expect((await json(confirmed)).payment).toMatchObject({ id, status: 'processing' });
  });

  it('fails a transaction that does not pay the request', async () => {
    const { id, request } = await startPayment();
    payOnChain(request, { underpay: true });
    const response = await token({ payment_id: id, payment_evidence: SIGNATURE });
    expect(response.status).toBe(402);
    const body = await json(response);
    expect(body.payment).toMatchObject({ status: 'failed' });
    expect(body.payment.reason).toMatch(/no matching transfer/);
  });

  it('expires an unpaid request', async () => {
    const { id } = await startPayment();
    clock = new Date(clock.getTime() + 11 * 60_000);
    const response = await token({ payment_id: id });
    expect((await json(response)).payment).toMatchObject({ status: 'expired' });
  });

  it('requires the retry to repeat the same license and resource', async () => {
    const { id } = await startPayment();
    const response = await token({ payment_id: id, payment_evidence: SIGNATURE, scope: 'likeness', resource: 'HCRN-0000-006B-J' });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'invalid_request' });
  });

  it("does not let another client settle someone else's payment", async () => {
    const { id, request } = await startPayment();
    payOnChain(request);
    const response = await token({ payment_id: id, payment_evidence: SIGNATURE }, OTHER_CLIENT);
    expect(response.status).toBe(400);
    expect(services.payments.get(id)?.status).toBe('requires_payment');
  });

  it('keeps the payment but refuses the license if the declaration was withdrawn meanwhile', async () => {
    const { id, request } = await startPayment();
    const current = new TextDecoder().decode(services.registry.declaration(MIRA)!.content);
    services.registry.publish(current.replace('max-age="7"', 'max-age="7" status="withdrawn"'));
    payOnChain(request);
    const response = await token({ payment_id: id, payment_evidence: SIGNATURE });
    expect(response.status).toBe(403);
    const body = await json(response);
    expect(body).toMatchObject({ error: 'invalid_license', reason_code: 'not_operative', payment: { id, status: 'succeeded' } });
    expect(services.licenses.licenseForRequest(request.licenseRequestId)).toBeUndefined();
  });
});

describe('payment storage', () => {
  it('never accepts one transaction for two payments (replay protection)', async () => {
    const a = await startPayment();
    const b = await startPayment();
    const receipt = { provider: 'solana-usdc-devnet' as const, paymentId: a.id, externalRef: SIGNATURE, amount: a.request.amount, paidAt: clock.toISOString(), finality: 'finalized' as const, testMode: true as const };
    services.payments.markSucceeded(a.id, SIGNATURE, receipt);
    expect(() => services.payments.markSucceeded(b.id, SIGNATURE, { ...receipt, paymentId: b.id })).toThrow();
  });
});

describe('payment poller (fallback when the client never reports the signature)', () => {
  it('finds the payment on-chain by memo and issues the license', async () => {
    const { id, request } = await startPayment();
    payOnChain(request);
    rpc.history = [{ signature: OTHER_SIGNATURE, err: null, memo: '[47] gm1:other', blockTime: null }, { signature: SIGNATURE, err: null, memo: `[47] ${request.memo}`, blockTime: null }];
    expect(await services.paymentService.poll()).toBe(1);
    expect(services.payments.get(id)?.status).toBe('succeeded');
    expect(services.licenses.licenseForRequest(request.licenseRequestId)).toBeDefined();
  });

  it('marks stale unpaid requests as expired', async () => {
    const { id } = await startPayment();
    clock = new Date(clock.getTime() + 20 * 60_000);
    await services.paymentService.poll();
    expect(services.payments.get(id)?.status).toBe('expired');
  });
});

describe('/v1/payments/:id', () => {
  it('reports the status to the client that owns it', async () => {
    const { id } = await startPayment();
    const response = await app.request(`/v1/payments/${id}`, { headers: { authorization: basic() } });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ id, status: 'requires_payment' });
    expect((await app.request(`/v1/payments/${id}`, { headers: { authorization: OTHER_CLIENT } })).status).toBe(404);
    expect((await app.request(`/v1/payments/${id}`)).status).toBe(401);
  });

  it('rebuilds the transaction with a fresh blockhash and the same memo', async () => {
    const { id, request } = await startPayment();
    const response = await app.request(`/v1/payments/${id}/transaction`, { method: 'POST', headers: { authorization: basic() } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.accepts[0].memo).toBe(request.memo);
    expect(body.accepts[0].transaction).not.toBe(request.transaction);
  });
});
