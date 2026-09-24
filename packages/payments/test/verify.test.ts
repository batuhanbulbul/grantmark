import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVNET_USDC_MINT } from '../src/solana';
import { verifyTransfer, type ExpectedPayment, type ParsedTransaction } from '../src/verify';

// A real devnet USDC TransferChecked with a memo, recorded from api.devnet.solana.com
// (getTransaction, jsonParsed) on 2026-09-24. Public chain data.
const RECORDED = JSON.parse(
  readFileSync(new URL('../../../fixtures/solana/devnet-transfer-checked.json', import.meta.url), 'utf8'),
) as ParsedTransaction;

const DESTINATION = 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3';
const BLOCK_TIME = new Date(1790215241 * 1000);

const expected = (overrides: Partial<ExpectedPayment> = {}): ExpectedPayment => ({
  memo: '1584b551-8204-4a2d-b924-5b0d32c0c3d8',
  transfers: [{ tokenAccount: DESTINATION, amount: 1000n }],
  notBefore: new Date(BLOCK_TIME.getTime() - 60_000),
  notAfter: new Date(BLOCK_TIME.getTime() + 60_000),
  ...overrides,
});

/** A deep copy of the recorded transaction with one change applied. */
function variant(change: (tx: any) => void): ParsedTransaction {
  const copy = structuredClone(RECORDED) as any;
  change(copy);
  return copy;
}
const transferIx = (tx: any) => tx.transaction.message.instructions.find((ix: any) => ix.parsed?.type === 'transferChecked');
const reason = (tx: ParsedTransaction | null, overrides: Partial<ExpectedPayment> = {}) => {
  const result = verifyTransfer(tx, expected(overrides));
  return result.ok ? 'ok' : result.reason;
};

describe('verifyTransfer on a recorded devnet transaction', () => {
  it('accepts the payment it describes', () => {
    expect(verifyTransfer(RECORDED, expected())).toEqual({ ok: true, blockTime: BLOCK_TIME, slot: 503239782 });
  });

  it('checks the mint against devnet USDC', () => {
    expect(transferIx(RECORDED).parsed.info.mint).toBe(DEVNET_USDC_MINT);
  });

  it('treats a missing transaction as pending, not unpaid', () => {
    expect(verifyTransfer(null, expected())).toEqual({ ok: false, pending: true, reason: 'transaction not found yet' });
  });

  it.each([
    ['a failed transaction', (tx: any) => (tx.meta.err = { InstructionError: [2, 'Custom'] }), /failed on-chain/],
    ['another mint', (tx: any) => (transferIx(tx).parsed.info.mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), /no matching transfer/],
    ['another token program', (tx: any) => (transferIx(tx).programId = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), /no matching transfer/],
    ['wrong decimals', (tx: any) => (transferIx(tx).parsed.info.tokenAmount.decimals = 9), /no matching transfer/],
    ['a smaller amount', (tx: any) => (transferIx(tx).parsed.info.tokenAmount.amount = '999'), /no matching transfer/],
    ['a plain transfer instead of transferChecked', (tx: any) => (transferIx(tx).parsed.type = 'transfer'), /no matching transfer/],
    ['a second matching transfer', (tx: any) => tx.transaction.message.instructions.push(structuredClone(transferIx(tx))), /more than one/],
    ['a changed memo', (tx: any) => (tx.transaction.message.instructions.find((ix: any) => ix.program === 'spl-memo').parsed = 'other'), /memo/],
    ['no memo', (tx: any) => (tx.transaction.message.instructions = tx.transaction.message.instructions.filter((ix: any) => ix.program !== 'spl-memo')), /memo/],
    ['a balance that did not grow', (tx: any) => (tx.meta.postTokenBalances[0].uiTokenAmount.amount = '367531000'), /balance/],
    ['no block time', (tx: any) => (tx.blockTime = null), /block time/],
  ])('rejects %s', (_label, change, message) => {
    expect(reason(variant(change))).toMatch(message);
  });

  it('rejects a payment outside the allowed time window', () => {
    expect(reason(RECORDED, { notAfter: new Date(BLOCK_TIME.getTime() - 1000) })).toMatch(/after/);
    expect(reason(RECORDED, { notBefore: new Date(BLOCK_TIME.getTime() + 1000) })).toMatch(/before/);
  });

  it('rejects a payment to another account', () => {
    expect(reason(RECORDED, { transfers: [{ tokenAccount: 'FrnR1soPazH2Ny1b2LLv8UQJDGpmuHiz7DstS1fikoqH', amount: 1000n }] })).toMatch(
      /no matching transfer/,
    );
  });

  it('requires every expected split', () => {
    const second = { tokenAccount: 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb', amount: 10n };
    expect(reason(RECORDED, { transfers: [{ tokenAccount: DESTINATION, amount: 1000n }, second] })).toMatch(/no matching transfer/);
  });

  it('does not depend on instruction order, since wallets may add instructions', () => {
    const shuffled = variant((tx) => {
      tx.transaction.message.instructions.reverse();
      tx.transaction.message.instructions.push({ programId: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', accounts: [], data: '', stackHeight: 1 });
    });
    expect(verifyTransfer(shuffled, expected()).ok).toBe(true);
  });

  it('accepts decimals as a bigint, as @solana/kit returns them from a live RPC', () => {
    const fromKit = variant((tx) => (transferIx(tx).parsed.info.tokenAmount.decimals = 6n));
    expect(verifyTransfer(fromKit, expected()).ok).toBe(true);
  });

  it('treats a destination account created in the same transaction as starting from zero', () => {
    const created = variant((tx) => {
      tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b: any) => b.accountIndex !== 2);
      tx.meta.postTokenBalances.find((b: any) => b.accountIndex === 2).uiTokenAmount.amount = '1000';
    });
    expect(verifyTransfer(created, expected()).ok).toBe(true);
  });
});
