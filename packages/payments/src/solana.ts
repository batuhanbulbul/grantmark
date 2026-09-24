/**
 * Solana devnet USDC: constants and the unsigned payment transaction.
 *
 * The server builds the transaction and the payer's wallet signs and sends it, so the server
 * never holds a Solana private key. One transaction pays every payee atomically: for each payee
 * an idempotent associated-token-account creation (so fresh wallets work) and a TransferChecked,
 * followed by the commitment memo.
 */

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from '@solana/kit';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V3, getAddMemoInstruction } from '@solana-program/memo';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';

/** Circle's devnet USDC mint: classic SPL Token program, 6 decimals. */
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const USDC_DECIMALS = 6;
/** Devnet as a CAIP-2 chain id, the form x402 uses. */
export const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const TOKEN_PROGRAM: string = TOKEN_PROGRAM_ADDRESS;
/**
 * The SPL Memo program (v3, `MemoSq4g…`). `@solana-program/memo` 0.15 defaults to a newer memo
 * program; Grantmark uses this one because RPC nodes parse it as `spl-memo` in `jsonParsed`
 * responses, which the verifier and Solana's verification guide rely on.
 */
export const MEMO_PROGRAM: string = LEGACY_MEMO_PROGRAM_ADDRESS_V3;
/** Largest memo the SPL Memo program accepts without signers. */
export const MAX_MEMO_BYTES = 566;

/** Whether a string is a base58 Solana address (a public key). */
export const isSolanaAddress = (value: string): boolean => isAddress(value);

export async function associatedTokenAccount(owner: string, mint: string = DEVNET_USDC_MINT): Promise<string> {
  const [account] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return account;
}

export interface PaymentTransactionInput {
  /** The payer's wallet: fee payer, signer, and owner of the source USDC account. */
  readonly payer: string;
  readonly transfers: readonly { readonly owner: string; readonly amount: bigint }[];
  readonly memo: string;
  readonly blockhash: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
}

/** The unsigned transaction as base64 wire bytes, ready for `signAndSendTransaction`. */
export async function buildPaymentTransaction(input: PaymentTransactionInput): Promise<string> {
  if (!isAddress(input.payer)) throw new RangeError(`not a Solana address: ${input.payer}`);
  if (input.transfers.length === 0) throw new RangeError('at least one transfer is required');
  for (const transfer of input.transfers) {
    if (!isAddress(transfer.owner)) throw new RangeError(`not a Solana address: ${transfer.owner}`);
    if (transfer.amount <= 0n) throw new RangeError('transfer amounts must be positive');
  }
  if (new TextEncoder().encode(input.memo).length > MAX_MEMO_BYTES) throw new RangeError('memo is too long');

  const payer = createNoopSigner(address(input.payer));
  const mint = address(DEVNET_USDC_MINT);
  const source = address(await associatedTokenAccount(input.payer));
  const payees = await Promise.all(
    input.transfers.map(async (t) => ({
      owner: address(t.owner),
      destination: address(await associatedTokenAccount(t.owner)),
      amount: t.amount,
    })),
  );
  const creates = payees.map((p) => getCreateAssociatedTokenIdempotentInstruction({ payer, ata: p.destination, owner: p.owner, mint }));
  const transfers = payees.map((p) =>
    getTransferCheckedInstruction({ source, mint, destination: p.destination, authority: payer, amount: p.amount, decimals: USDC_DECIMALS }),
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: input.blockhash.blockhash as Blockhash, lastValidBlockHeight: input.blockhash.lastValidBlockHeight },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [...creates, ...transfers, getAddMemoInstruction({ memo: input.memo }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 })],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
