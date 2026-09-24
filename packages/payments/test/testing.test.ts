import { describe, expect, it } from 'vitest';
import { DEVNET_GENESIS_HASH, type SolanaRpc, type SignatureInfo } from '../src/rpc';
import { SolanaUsdcDevnet, type PaymentInput, type SolanaPaymentRequest } from '../src/providers';
import { parsedTransactionFor } from '../src/testing';
import { verifyTransfer, type ParsedTransaction } from '../src/verify';

const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const RIGHTS_HOLDER = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const OPERATOR = 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb';
const NOW = new Date('2026-10-01T12:00:00Z');
const SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';
const OTHER = '2nswcx5mYMvEty8nZc7pAQ1QPnKACZyR7TJL9Mi1VRxMJQhG9BwvJnc69ZgdopQYNzPDsSkAoDqUzkKnSgVHn8rb';

class FakeRpc implements SolanaRpc {
  finalized = new Map<string, ParsedTransaction>();
  history: SignatureInfo[] = [];
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
    return this.history;
  }
}

const input: PaymentInput = {
  paymentId: 'pay_TEST',
  licenseRequestId: 'lrq_TEST',
  amount: { value: '5.00', currency: 'USD' },
  payer: PAYER,
  payees: [
    { role: 'rights_holder', wallet: RIGHTS_HOLDER, bps: 9000 },
    { role: 'operator_fee', wallet: OPERATOR, bps: 1000 },
  ],
  terms: { hcrn: 'HCRN-0000-0068-F' },
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 600_000),
};

async function request(rpc: FakeRpc): Promise<SolanaPaymentRequest> {
  return new SolanaUsdcDevnet(rpc).createPaymentRequest(input);
}

describe('parsedTransactionFor (test helper)', () => {
  it('produces a jsonParsed transaction that pays the request', async () => {
    const rpc = new FakeRpc();
    const payment = await request(rpc);
    const tx = parsedTransactionFor(payment, { signature: SIGNATURE, paidAt: new Date(NOW.getTime() + 30_000) });
    const check = verifyTransfer(tx, {
      memo: payment.memo,
      transfers: payment.splits.map((s) => ({ tokenAccount: s.tokenAccount, amount: BigInt(s.amount) })),
      notBefore: NOW,
      notAfter: new Date(payment.expiresAt),
    });
    expect(check).toMatchObject({ ok: true });
    expect(tx.transaction.signatures).toEqual([SIGNATURE]);
  });

  it('can underpay, for negative tests', async () => {
    const payment = await request(new FakeRpc());
    const tx = parsedTransactionFor(payment, { signature: SIGNATURE, paidAt: NOW, underpay: true });
    expect(
      verifyTransfer(tx, {
        memo: payment.memo,
        transfers: payment.splits.map((s) => ({ tokenAccount: s.tokenAccount, amount: BigInt(s.amount) })),
        notBefore: NOW,
        notAfter: new Date(payment.expiresAt),
      }).ok,
    ).toBe(false);
  });
});

describe('SolanaUsdcDevnet.findPayment (fallback when the client never reports a signature)', () => {
  it('finds the payment among recent transactions of the rights holder account, by memo', async () => {
    const rpc = new FakeRpc();
    const payment = await request(rpc);
    rpc.finalized.set(SIGNATURE, parsedTransactionFor(payment, { signature: SIGNATURE, paidAt: new Date(NOW.getTime() + 30_000) }));
    rpc.history = [
      { signature: OTHER, err: null, memo: '[47] gm1:someone-else', blockTime: null },
      { signature: SIGNATURE, err: null, memo: `[47] ${payment.memo}`, blockTime: null },
    ];
    expect(await new SolanaUsdcDevnet(rpc).findPayment(payment)).toBe(SIGNATURE);
  });

  it('skips failed transactions and ones that do not verify', async () => {
    const rpc = new FakeRpc();
    const payment = await request(rpc);
    rpc.finalized.set(SIGNATURE, parsedTransactionFor(payment, { signature: SIGNATURE, paidAt: NOW, underpay: true }));
    rpc.history = [
      { signature: OTHER, err: { InstructionError: [0, 'x'] }, memo: `[47] ${payment.memo}`, blockTime: null },
      { signature: SIGNATURE, err: null, memo: `[47] ${payment.memo}`, blockTime: null },
    ];
    expect(await new SolanaUsdcDevnet(rpc).findPayment(payment)).toBeUndefined();
  });
});

describe('SolanaUsdcDevnet.recheck (verification from a receipt, without the stored request)', () => {
  it('re-reads a finalized transaction and checks it against expected transfers and memo', async () => {
    const rpc = new FakeRpc();
    const payment = await request(rpc);
    rpc.finalized.set(SIGNATURE, parsedTransactionFor(payment, { signature: SIGNATURE, paidAt: new Date(NOW.getTime() + 30_000) }));
    const provider = new SolanaUsdcDevnet(rpc);
    const expected = {
      memo: payment.memo,
      transfers: payment.splits.map((s) => ({ tokenAccount: s.tokenAccount, amount: BigInt(s.amount) })),
      notBefore: new Date(0),
      notAfter: new Date(payment.expiresAt),
    };
    expect(await provider.recheck(SIGNATURE, expected)).toMatchObject({ ok: true });
    expect(await provider.recheck(OTHER, expected)).toMatchObject({ ok: false, pending: true });
    expect(await provider.recheck('not a signature', expected)).toMatchObject({ ok: false });
  });
});
