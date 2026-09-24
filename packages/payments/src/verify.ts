/**
 * Server-side verification of a devnet USDC payment, following Solana's "Verification Tools"
 * guide: read the transaction (`jsonParsed`), never trust the client, check the mint, token
 * program and decimals, require exactly one matching TransferChecked per payee regardless of
 * instruction order (wallets add instructions), cross-check balance changes, match the memo and
 * the time window. Replay protection (one use per signature) is the caller's job.
 */

import { DEVNET_USDC_MINT, MEMO_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS } from './solana';

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

interface ParsedInstruction {
  readonly programId: string;
  readonly program?: string;
  readonly parsed?: unknown;
}

/** The parts of a `getTransaction` result (`jsonParsed`) the verifier reads. */
export interface ParsedTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly preTokenBalances?: readonly TokenBalance[] | null;
    readonly postTokenBalances?: readonly TokenBalance[] | null;
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: {
      readonly accountKeys: readonly (string | { readonly pubkey: string })[];
      readonly instructions: readonly ParsedInstruction[];
    };
  };
}

export interface ExpectedPayment {
  readonly memo: string;
  /** One entry per payee: the destination token account and the exact amount in base units. */
  readonly transfers: readonly { readonly tokenAccount: string; readonly amount: bigint }[];
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export type TransferCheck =
  | { readonly ok: true; readonly blockTime: Date; readonly slot: number }
  | { readonly ok: false; readonly reason: string; readonly pending?: true };

interface TransferInfo {
  mint?: unknown;
  destination?: unknown;
  tokenAmount?: { amount?: unknown; decimals?: unknown };
}

function transferCheckedInfo(instruction: ParsedInstruction): TransferInfo | undefined {
  if (instruction.programId !== TOKEN_PROGRAM) return undefined;
  const parsed = instruction.parsed as { type?: unknown; info?: TransferInfo } | undefined;
  return parsed?.type === 'transferChecked' ? parsed.info : undefined;
}

export function verifyTransfer(tx: ParsedTransaction | null, expected: ExpectedPayment): TransferCheck {
  if (tx === null) return { ok: false, pending: true, reason: 'transaction not found yet' };
  if (tx.meta === null || tx.meta.err !== null) return { ok: false, reason: 'the transaction failed on-chain' };

  const { instructions, accountKeys } = tx.transaction.message;
  if (!instructions.some((ix) => ix.programId === MEMO_PROGRAM && ix.parsed === expected.memo)) {
    return { ok: false, reason: 'the memo does not match this payment' };
  }

  const keys = accountKeys.map((key) => (typeof key === 'string' ? key : key.pubkey));
  const balance = (list: readonly TokenBalance[] | null | undefined, index: number) =>
    list?.find((b) => b.accountIndex === index && b.mint === DEVNET_USDC_MINT);

  for (const { tokenAccount, amount } of expected.transfers) {
    const matches = instructions.filter((ix) => {
      const info = transferCheckedInfo(ix);
      return (
        info !== undefined &&
        info.mint === DEVNET_USDC_MINT &&
        info.destination === tokenAccount &&
        // @solana/kit parses decimals as a bigint; raw JSON-RPC responses hold a number.
        Number(info.tokenAmount?.decimals) === USDC_DECIMALS &&
        info.tokenAmount?.amount === amount.toString()
      );
    });
    if (matches.length === 0) return { ok: false, reason: `no matching transfer of ${amount} to ${tokenAccount}` };
    if (matches.length > 1) return { ok: false, reason: `more than one matching transfer to ${tokenAccount}` };

    // A token account created in the same transaction has no pre-balance: it started at zero.
    const index = keys.indexOf(tokenAccount);
    const before = BigInt(balance(tx.meta.preTokenBalances, index)?.uiTokenAmount.amount ?? '0');
    const after = balance(tx.meta.postTokenBalances, index);
    if (after === undefined || BigInt(after.uiTokenAmount.amount) - before < amount) {
      return { ok: false, reason: `the balance of ${tokenAccount} did not grow by ${amount}` };
    }
  }

  if (tx.blockTime === null) return { ok: false, reason: 'the transaction has no block time yet' };
  const blockTime = new Date(tx.blockTime * 1000);
  if (blockTime < expected.notBefore) return { ok: false, reason: 'paid before this payment request was created' };
  if (blockTime > expected.notAfter) return { ok: false, reason: 'paid after this payment request expired' };
  return { ok: true, blockTime, slot: tx.slot };
}
