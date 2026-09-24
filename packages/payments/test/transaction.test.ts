import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getUtf8Decoder } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, getTransferCheckedInstructionDataDecoder } from '@solana-program/token';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { describe, expect, it } from 'vitest';
import { DEVNET_USDC_MINT, associatedTokenAccount, buildPaymentTransaction } from '../src/solana';

// Addresses of fictional devnet test wallets (public keys only).
const PAYER = '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t';
const RIGHTS_HOLDER = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const OPERATOR = 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb';
const BLOCKHASH = { blockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', lastValidBlockHeight: 1000n };

async function decode(base64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const accounts = message.staticAccounts;
  const instructions = message.instructions.map((ix) => ({
    program: accounts[ix.programAddressIndex],
    accounts: (ix.accountIndices ?? []).map((i) => accounts[i]),
    data: ix.data ?? new Uint8Array(),
  }));
  return { transaction, message, instructions };
}

describe('associatedTokenAccount', () => {
  it('derives the USDC account of a wallet (the recorded devnet destination)', async () => {
    expect(await associatedTokenAccount(RIGHTS_HOLDER)).toBe('DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3');
  });
});

describe('buildPaymentTransaction', () => {
  const build = () =>
    buildPaymentTransaction({
      payer: PAYER,
      transfers: [
        { owner: RIGHTS_HOLDER, amount: 4_500_000n },
        { owner: OPERATOR, amount: 500_000n },
      ],
      memo: 'gm1:test-memo',
      blockhash: BLOCKHASH,
    });

  it('is unsigned, with the payer as fee payer and the given blockhash', async () => {
    const { transaction, message } = await decode(await build());
    expect(Object.keys(transaction.signatures)).toEqual([PAYER]);
    expect(transaction.signatures[PAYER as keyof typeof transaction.signatures]).toBeNull();
    expect(message.staticAccounts[0]).toBe(PAYER);
    expect(message.lifetimeToken).toBe(BLOCKHASH.blockhash);
  });

  it('creates each payee account if needed, then transfers each split and adds the memo', async () => {
    const { instructions } = await decode(await build());
    expect(instructions.map((ix) => ix.program)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      MEMO_PROGRAM_ADDRESS,
    ]);

    const transfers = instructions.filter((ix) => ix.program === TOKEN_PROGRAM_ADDRESS);
    const source = await associatedTokenAccount(PAYER);
    expect(transfers.map((ix) => ix.accounts)).toEqual([
      [source, DEVNET_USDC_MINT, await associatedTokenAccount(RIGHTS_HOLDER), PAYER],
      [source, DEVNET_USDC_MINT, await associatedTokenAccount(OPERATOR), PAYER],
    ]);
    const data = transfers.map((ix) => getTransferCheckedInstructionDataDecoder().decode(ix.data));
    expect(data.map((d) => [d.amount, d.decimals])).toEqual([
      [4_500_000n, 6],
      [500_000n, 6],
    ]);

    const memo = instructions.find((ix) => ix.program === MEMO_PROGRAM_ADDRESS)!;
    expect(getUtf8Decoder().decode(memo.data)).toBe('gm1:test-memo');
  });

  it.each([
    ['an invalid payer', { payer: 'not-an-address' }],
    ['an invalid payee', { transfers: [{ owner: 'nope', amount: 1n }] }],
    ['a zero amount', { transfers: [{ owner: RIGHTS_HOLDER, amount: 0n }] }],
    ['no transfers', { transfers: [] }],
    ['a memo over 566 bytes', { memo: 'x'.repeat(567) }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      buildPaymentTransaction({
        payer: PAYER,
        transfers: [{ owner: RIGHTS_HOLDER, amount: 1n }],
        memo: 'gm1:x',
        blockhash: BLOCKHASH,
        ...overrides,
      }),
    ).rejects.toThrow();
  });
});
