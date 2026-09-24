/**
 * Test helper (import from `@grantmark/payments/testing`): the `jsonParsed` transaction a wallet
 * would produce by paying a payment request, so the flow can be tested without a funded wallet.
 * Never used to settle real payments; the server only accepts transactions read from devnet.
 */

import type { SolanaPaymentRequest } from './providers';
import { DEVNET_USDC_MINT, MEMO_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS } from './solana';
import type { ParsedTransaction } from './verify';

export interface SimulatedPayment {
  readonly signature: string;
  readonly paidAt: Date;
  /** Pay one base unit less than asked to the first payee. */
  readonly underpay?: boolean | undefined;
}

export function parsedTransactionFor(request: SolanaPaymentRequest, payment: SimulatedPayment): ParsedTransaction {
  const sourceAccount = 'So11111111111111111111111111111111111111112';
  const accountKeys = [request.payer, sourceAccount, ...request.splits.map((s) => s.tokenAccount)];
  const amounts = request.splits.map((s, i) => BigInt(s.amount) - (payment.underpay === true && i === 0 ? 1n : 0n));
  const balance = (accountIndex: number, amount: bigint) => ({
    accountIndex,
    mint: DEVNET_USDC_MINT,
    uiTokenAmount: { amount: amount.toString(), decimals: USDC_DECIMALS },
  });

  return {
    slot: 1,
    blockTime: Math.floor(payment.paidAt.getTime() / 1000),
    meta: {
      err: null,
      preTokenBalances: request.splits.map((_, i) => balance(i + 2, 0n)),
      postTokenBalances: request.splits.map((_, i) => balance(i + 2, amounts[i]!)),
    },
    transaction: {
      signatures: [payment.signature],
      message: {
        accountKeys: accountKeys.map((pubkey) => ({ pubkey })),
        instructions: [
          ...request.splits.map((split, i) => ({
            programId: TOKEN_PROGRAM,
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                source: sourceAccount,
                destination: split.tokenAccount,
                mint: DEVNET_USDC_MINT,
                authority: request.payer,
                tokenAmount: { amount: amounts[i]!.toString(), decimals: USDC_DECIMALS },
              },
            },
          })),
          { programId: MEMO_PROGRAM, program: 'spl-memo', parsed: request.memo },
        ],
      },
    },
  };
}
