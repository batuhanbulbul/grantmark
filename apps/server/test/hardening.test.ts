import { DEVNET_GENESIS_HASH, type SolanaRpc } from '@grantmark/payments';
import { describe, expect, it } from 'vitest';
import { createApp, createServices } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { seedPersonas } from '../src/seed';

const MIRA = 'HCRN-0000-0068-F';
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';

/** A devnet RPC that can be switched off. */
class FlakyRpc implements SolanaRpc {
  down = false;
  private check() {
    if (this.down) throw new Error('fetch failed: devnet unreachable');
  }
  async getLatestBlockhash() {
    this.check();
    return { blockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 1000n };
  }
  async getTransaction() {
    this.check();
    return null;
  }
  async getGenesisHash() {
    this.check();
    return DEVNET_GENESIS_HASH;
  }
  async getSignaturesForAddress() {
    this.check();
    return [];
  }
}

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ PUBLIC_BASE_URL: 'https://grantmark.test', ...env });
  const rpc = new FlakyRpc();
  const services = createServices(openDatabase(':memory:'), config, () => new Date('2026-10-01T12:00:00Z'), { solanaRpc: rpc });
  seedPersonas(services.registry, config);
  services.payees.setRightsHolderWallet(MIRA, '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza');
  services.clients.create('Demo Studio', { clientId: 'demo-studio', secret: 'demo-studio-secret-value' });
  return { app: createApp(services, config, { webDist: 'no-such-folder' }), rpc, services };
}

const CLAIM = 'hardening-test-browser-claim';
const demo = (app: ReturnType<typeof setup>['app'], body: object, headers: Record<string, string> = {}) =>
  app.request('/v1/demo/licenses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ claim: CLAIM, ...body }),
  });

describe('when devnet is unreachable', () => {
  it('answers 503 instead of failing when a payment is started', async () => {
    const { app, rpc } = setup();
    rpc.down = true;
    const response = await demo(app, { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('keeps a payment pending when it cannot be verified', async () => {
    const { app, rpc, services } = setup();
    const { payment } = (await (await demo(app, { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER })).json()) as { payment: { id: string } };
    rpc.down = true;
    const response = await demo(app, { hcrn: MIRA, license: 1, scope: 'image', payment_id: payment.id, payment_evidence: SIGNATURE });
    expect(response.status).toBe(402);
    const body = (await response.json()) as { payment: { status: string; reason: string } };
    expect(body.payment.status).toBe('requires_payment');
    expect(body.payment.reason).toMatch(/unavailable/);
    expect(services.payments.get(payment.id)?.status).toBe('requires_payment');
  });

  it('lets the poller carry on', async () => {
    const { app, rpc, services } = setup();
    await demo(app, { hcrn: MIRA, license: 1, scope: 'image', payer: PAYER });
    rpc.down = true;
    await expect(services.paymentService.poll()).resolves.toBe(0);
  });
});

describe('security headers', () => {
  it('sets a strict content security policy and related headers', async () => {
    const { app } = setup();
    const response = await app.request('/health');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('rate limiting of public endpoints', () => {
  it('limits requests per client address and says when to retry', async () => {
    const { app } = setup({ RATE_LIMIT_PER_MINUTE: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await app.request('/v1/verify?license=lic_UNKNOWN')).status);
    expect(statuses).toEqual([404, 404, 404, 429]);
    const limited = await app.request('/v1/verify?license=lic_UNKNOWN');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('does not limit the registry routes that other systems poll', async () => {
    const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.request('/registry/declarations/HCRN-0000-0068-F')).status);
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('limits OLP and payment endpoints more generously, before client authentication runs', async () => {
    const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1' });
    const wrongSecret = { authorization: `Basic ${Buffer.from('demo-studio:wrong-secret').toString('base64')}` };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await app.request('/olp/introspect', { method: 'POST', headers: wrongSecret })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    // The same budget covers the payment endpoints.
    expect((await app.request('/v1/payments/pay_x', { headers: wrongSecret })).status).toBe(429);
  });

  it('counts the address the proxy appended, not one the client wrote into X-Forwarded-For', async () => {
    const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: '1' });
    await app.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.1' } });
    const spoofed = await app.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.1' } });
    expect(spoofed.status).toBe(429);
  });

  it('ignores X-Forwarded-For unless the server is told it sits behind a proxy', async () => {
    const direct = setup({ RATE_LIMIT_PER_MINUTE: '1' }).app;
    await direct.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '203.0.113.1' } });
    expect((await direct.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(429);

    const proxied = setup({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: '1' }).app;
    await proxied.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '203.0.113.1' } });
    expect((await proxied.request('/v1/verify?license=x', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(404);
  });
});

describe('request size limits', () => {
  it('refuses oversized JSON bodies on the demo and evaluation endpoints', async () => {
    const { app } = setup();
    const big = (bytes: number) => JSON.stringify({ hcrn: MIRA, license: 1, padding: 'x'.repeat(bytes) });
    const post = (path: string, body: string) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post('/v1/demo/licenses', big(100_000))).status).toBe(413);
    expect((await post('/v1/evaluate', big(3_000_000))).status).toBe(413);
    expect(await (await post('/v1/evaluate', big(3_000_000))).json()).toMatchObject({ error: 'invalid_request' });
  });
});
