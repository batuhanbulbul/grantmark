import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commitmentMemo } from '../src/commitment';
import { DEVNET_GENESIS_HASH, assertDevnetGenesis, type SolanaRpc } from '../src/rpc';
import { SolanaUsdcDevnet, StripeTestMode, type PaymentInput } from '../src/providers';
import type { ParsedTransaction } from '../src/verify';

const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const RIGHTS_HOLDER = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const OPERATOR = 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb';
const NOW = new Date('2026-10-01T12:00:00Z');

const RECORDED = JSON.parse(
  readFileSync(new URL('../../../fixtures/solana/devnet-transfer-checked.json', import.meta.url), 'utf8'),
) as ParsedTransaction;

class FakeRpc implements SolanaRpc {
  transactions = new Map<string, { finalized?: ParsedTransaction; confirmed?: ParsedTransaction }>();
  async getLatestBlockhash() {
    return { blockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 1000n };
  }
  async getTransaction(signature: string, commitment: 'confirmed' | 'finalized') {
    return this.transactions.get(signature)?.[commitment] ?? null;
  }
  async getGenesisHash() {
    return DEVNET_GENESIS_HASH;
  }
  async getSignaturesForAddress() {
    return [];
  }
}

const input = (overrides: Partial<PaymentInput> = {}): PaymentInput => ({
  paymentId: 'pay_TEST',
  licenseRequestId: 'lrq_TEST',
  amount: { value: '5.00', currency: 'USD' },
  payer: PAYER,
  payees: [
    { role: 'rights_holder', wallet: RIGHTS_HOLDER, bps: 9000 },
    { role: 'operator_fee', wallet: OPERATOR, bps: 1000 },
  ],
  terms: { hcrn: 'HCRN-0000-0068-F', usage: ['hcs:ai-generate'], client: 'demo-studio' },
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 10 * 60_000),
  ...overrides,
});

describe('SolanaUsdcDevnet.createPaymentRequest', () => {
  it('builds an x402-shaped request with the split, a commitment memo and an unsigned transaction', async () => {
    const provider = new SolanaUsdcDevnet(new FakeRpc(), () => 'nonce-1');
    const request = await provider.createPaymentRequest(input());
    expect(request).toMatchObject({
      provider: 'solana-usdc-devnet',
      paymentId: 'pay_TEST',
      licenseRequestId: 'lrq_TEST',
      amount: { amountMinor: '5000000', currency: 'USD', decimals: 6 },
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      payer: PAYER,
      expiresAt: '2026-10-01T12:10:00.000Z',
    });
    expect(request.splits).toEqual([
      { role: 'rights_holder', wallet: RIGHTS_HOLDER, tokenAccount: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3', amount: '4500000' },
      { role: 'operator_fee', wallet: OPERATOR, tokenAccount: expect.any(String), amount: '500000' },
    ]);
    expect(request.memo).toBe(commitmentMemo(request.commitment));
    expect(request.commitment).toMatchObject({
      v: 1,
      payment: 'pay_TEST',
      license_request: 'lrq_TEST',
      hcrn: 'HCRN-0000-0068-F',
      nonce: 'nonce-1',
      amount: { value: '5.00', currency: 'USD' },
    });
    expect(request.transaction.length).toBeGreaterThan(100);
  });

  it.each([
    ['a currency other than USD', { amount: { value: '5.00', currency: 'EUR' } }],
    ['no payer wallet', { payer: undefined }],
    ['an invalid payer', { payer: 'nope' }],
    ['payees that do not add up to 100%', { payees: [{ role: 'rights_holder' as const, wallet: RIGHTS_HOLDER, bps: 5000 }] }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(new SolanaUsdcDevnet(new FakeRpc()).createPaymentRequest(input(overrides as Partial<PaymentInput>))).rejects.toThrow();
  });

  it('refuses to run against a cluster other than devnet', async () => {
    const rpc = new FakeRpc();
    rpc.getGenesisHash = async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    await expect(new SolanaUsdcDevnet(rpc).createPaymentRequest(input())).rejects.toThrow(/devnet/);
  });
});

describe('SolanaUsdcDevnet.verifyPayment', () => {
  // The recorded transaction pays 1000 base units to RIGHTS_HOLDER's USDC account with a UUID memo.
  const recordedRequest = async (rpc: FakeRpc) => {
    const request = await new SolanaUsdcDevnet(rpc).createPaymentRequest(
      input({
        amount: { value: '0.001', currency: 'USD' },
        payees: [{ role: 'rights_holder', wallet: RIGHTS_HOLDER, bps: 10000 }],
        createdAt: new Date(1790215241 * 1000 - 60_000),
        expiresAt: new Date(1790215241 * 1000 + 60_000),
      }),
    );
    return { ...request, memo: '1584b551-8204-4a2d-b924-5b0d32c0c3d8' };
  };
  const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';

  it('succeeds at finalized commitment with a test-mode receipt', async () => {
    const rpc = new FakeRpc();
    rpc.transactions.set(SIGNATURE, { finalized: RECORDED, confirmed: RECORDED });
    const result = await new SolanaUsdcDevnet(rpc).verifyPayment(await recordedRequest(rpc), { signature: SIGNATURE });
    expect(result).toEqual({
      status: 'succeeded',
      receipt: {
        provider: 'solana-usdc-devnet',
        paymentId: 'pay_TEST',
        externalRef: SIGNATURE,
        amount: { amountMinor: '1000', currency: 'USD', decimals: 6 },
        paidAt: '2026-09-24T02:00:41.000Z',
        finality: 'finalized',
        testMode: true,
      },
    });
  });

  it('reports processing while only confirmed', async () => {
    const rpc = new FakeRpc();
    rpc.transactions.set(SIGNATURE, { confirmed: RECORDED });
    const result = await new SolanaUsdcDevnet(rpc).verifyPayment(await recordedRequest(rpc), { signature: SIGNATURE });
    expect(result).toMatchObject({ status: 'processing' });
  });

  it('keeps waiting while the transaction is not visible yet', async () => {
    const rpc = new FakeRpc();
    const result = await new SolanaUsdcDevnet(rpc).verifyPayment(await recordedRequest(rpc), { signature: SIGNATURE });
    expect(result).toMatchObject({ status: 'requires_payment' });
  });

  it('fails a transaction that does not match the request', async () => {
    const rpc = new FakeRpc();
    rpc.transactions.set(SIGNATURE, { finalized: RECORDED, confirmed: RECORDED });
    const request = { ...(await recordedRequest(rpc)), memo: 'gm1:another-request' };
    const result = await new SolanaUsdcDevnet(rpc).verifyPayment(request, { signature: SIGNATURE });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.reason).toMatch(/memo/);
  });

  it('rejects a malformed signature', async () => {
    const rpc = new FakeRpc();
    const result = await new SolanaUsdcDevnet(rpc).verifyPayment(await recordedRequest(rpc), { signature: 'not a signature' });
    expect(result).toMatchObject({ status: 'failed' });
  });
});

describe('assertDevnetGenesis', () => {
  it('accepts only the devnet genesis hash', () => {
    expect(() => assertDevnetGenesis(DEVNET_GENESIS_HASH)).not.toThrow();
    expect(() => assertDevnetGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).toThrow(/devnet/);
  });
});

describe('StripeTestMode (interface only in the MVP)', () => {
  it('refuses live keys', () => {
    expect(() => new StripeTestMode('sk_live_abc')).toThrow(/test/);
    expect(() => new StripeTestMode('sk_test_abc')).not.toThrow();
  });

  it('is not implemented yet', async () => {
    await expect(new StripeTestMode('sk_test_abc').createPaymentRequest(input())).rejects.toThrow(/not implemented/i);
  });
});
