/**
 * Payment providers. The core only sees the provider interface, so Stripe (test mode) or an
 * x402 adapter can be added without changing the license server. Providers keep no state: the
 * caller stores the payment request and passes it back for verification.
 */

import { randomBytes } from 'node:crypto';
import { isAddress, isSignature } from '@solana/kit';
import { commitmentMemo } from './commitment';
import { splitAmount, toBaseUnits, type PayeeRole } from './money';
import { assertDevnetGenesis, type SolanaRpc } from './rpc';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, USDC_DECIMALS, associatedTokenAccount, buildPaymentTransaction } from './solana';
import { verifyTransfer } from './verify';

export type ProviderId = 'solana-usdc-devnet' | 'stripe-test';
export type PaymentStatus = 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'expired';

export interface Money {
  readonly amountMinor: string;
  readonly currency: 'USD';
  readonly decimals: number;
}

export interface PaymentInput {
  readonly paymentId: string;
  readonly licenseRequestId: string;
  /** The declaration's price, as in `<amount currency="USD">`. */
  readonly amount: { readonly value: string; readonly currency: string };
  /** The payer's wallet (Solana). */
  readonly payer?: string | undefined;
  /** Who is paid; basis points must add up to 10,000. */
  readonly payees: readonly { readonly role: PayeeRole; readonly wallet: string; readonly bps: number }[];
  /** The license terms the payment is for (HCRN, usage, client, …); part of the commitment. */
  readonly terms: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface Split {
  readonly role: PayeeRole;
  readonly wallet: string;
  readonly tokenAccount: string;
  /** Base units. */
  readonly amount: string;
}

/** A Solana payment request; its field names follow x402's shape where they overlap. */
export interface SolanaPaymentRequest {
  readonly provider: 'solana-usdc-devnet';
  readonly paymentId: string;
  readonly licenseRequestId: string;
  readonly amount: Money;
  readonly network: string;
  readonly asset: string;
  readonly payer: string;
  readonly splits: readonly Split[];
  readonly memo: string;
  readonly commitment: Readonly<Record<string, unknown>>;
  /** Unsigned transaction, base64 wire format. */
  readonly transaction: string;
  readonly lastValidBlockHeight: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface Receipt {
  readonly provider: ProviderId;
  readonly paymentId: string;
  /** Transaction signature (Solana) or Checkout Session id (Stripe). */
  readonly externalRef: string;
  readonly amount: Money;
  readonly paidAt: string;
  readonly finality: 'finalized' | 'provider_final';
  /** Anything that is not devnet or a sandbox is rejected. */
  readonly testMode: true;
}

export interface VerificationResult {
  readonly status: PaymentStatus;
  readonly receipt?: Receipt | undefined;
  readonly reason?: string | undefined;
}

export interface PaymentEvidence {
  readonly signature?: string | undefined;
}

export interface PaymentProvider<Request> {
  readonly id: ProviderId;
  createPaymentRequest(input: PaymentInput): Promise<Request>;
  verifyPayment(request: Request, evidence: PaymentEvidence): Promise<VerificationResult>;
}

/** Clock skew allowed before a request's creation, and grace after its expiry. */
const SKEW_MS = 60_000;
const GRACE_MS = 120_000;

export class SolanaUsdcDevnet implements PaymentProvider<SolanaPaymentRequest> {
  readonly id = 'solana-usdc-devnet' as const;
  private readonly rpc: SolanaRpc;
  private readonly nonce: () => string;
  private devnetChecked: Promise<void> | undefined;

  constructor(rpc: SolanaRpc, nonce: () => string = () => randomBytes(16).toString('base64url')) {
    this.rpc = rpc;
    this.nonce = nonce;
  }

  private ensureDevnet(): Promise<void> {
    this.devnetChecked ??= this.rpc.getGenesisHash().then(assertDevnetGenesis);
    return this.devnetChecked;
  }

  async createPaymentRequest(input: PaymentInput): Promise<SolanaPaymentRequest> {
    if (input.amount.currency !== 'USD') throw new RangeError('prices must be in USD (settled 1:1 in devnet USDC)');
    if (input.payer === undefined || !isAddress(input.payer)) throw new RangeError('a valid payer wallet address is required');
    const payer = input.payer;
    await this.ensureDevnet();

    const total = toBaseUnits(input.amount.value, USDC_DECIMALS);
    const splits: Split[] = [];
    for (const share of splitAmount(total, input.payees)) {
      const wallet = input.payees.find((p) => p.role === share.role)!.wallet;
      if (!isAddress(wallet)) throw new RangeError(`not a Solana address: ${wallet}`);
      splits.push({ role: share.role, wallet, tokenAccount: await associatedTokenAccount(wallet), amount: share.amount.toString() });
    }

    const commitment = {
      v: 1,
      ...input.terms,
      payment: input.paymentId,
      license_request: input.licenseRequestId,
      amount: { value: input.amount.value, currency: 'USD' },
      network: DEVNET_NETWORK,
      asset: DEVNET_USDC_MINT,
      payees: splits.map((s) => ({ role: s.role, token_account: s.tokenAccount, amount: s.amount })),
      expires_at: input.expiresAt.toISOString(),
      nonce: this.nonce(),
    };
    const memo = commitmentMemo(commitment);
    const blockhash = await this.rpc.getLatestBlockhash();
    const transaction = await buildPaymentTransaction({
      payer,
      transfers: splits.map((s) => ({ owner: s.wallet, amount: BigInt(s.amount) })),
      memo,
      blockhash,
    });

    return {
      provider: this.id,
      paymentId: input.paymentId,
      licenseRequestId: input.licenseRequestId,
      amount: { amountMinor: total.toString(), currency: 'USD', decimals: USDC_DECIMALS },
      network: DEVNET_NETWORK,
      asset: DEVNET_USDC_MINT,
      payer,
      splits,
      memo,
      commitment,
      transaction,
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
      createdAt: input.createdAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  /** The same payment with a fresh blockhash, for when the wallet took longer than its lifetime. */
  async refreshTransaction(request: SolanaPaymentRequest): Promise<SolanaPaymentRequest> {
    await this.ensureDevnet();
    const blockhash = await this.rpc.getLatestBlockhash();
    const transaction = await buildPaymentTransaction({
      payer: request.payer,
      transfers: request.splits.map((s) => ({ owner: s.wallet, amount: BigInt(s.amount) })),
      memo: request.memo,
      blockhash,
    });
    return { ...request, transaction, lastValidBlockHeight: blockhash.lastValidBlockHeight.toString() };
  }

  /** Succeeds only at `finalized` commitment; `confirmed` reports processing. */
  async verifyPayment(request: SolanaPaymentRequest, evidence: PaymentEvidence): Promise<VerificationResult> {
    const signature = evidence.signature;
    if (signature === undefined || !isSignature(signature)) {
      return { status: 'failed', reason: 'a valid transaction signature is required' };
    }
    await this.ensureDevnet();
    const expected = {
      memo: request.memo,
      transfers: request.splits.map((s) => ({ tokenAccount: s.tokenAccount, amount: BigInt(s.amount) })),
      notBefore: new Date(Date.parse(request.createdAt) - SKEW_MS),
      notAfter: new Date(Date.parse(request.expiresAt) + GRACE_MS),
    };

    const finalized = await this.rpc.getTransaction(signature, 'finalized');
    if (finalized !== null) {
      const check = verifyTransfer(finalized, expected);
      if (!check.ok) return { status: 'failed', reason: check.reason };
      return {
        status: 'succeeded',
        receipt: {
          provider: this.id,
          paymentId: request.paymentId,
          externalRef: signature,
          amount: request.amount,
          paidAt: check.blockTime.toISOString(),
          finality: 'finalized',
          testMode: true,
        },
      };
    }

    const confirmed = await this.rpc.getTransaction(signature, 'confirmed');
    if (confirmed === null) return { status: 'requires_payment', reason: 'the transaction is not visible yet' };
    const check = verifyTransfer(confirmed, expected);
    return check.ok
      ? { status: 'processing', reason: 'confirmed; waiting for finalized commitment' }
      : { status: 'failed', reason: check.reason };
  }
}

/** Stripe in test mode. The interface is in place; the implementation comes after the MVP. */
export class StripeTestMode implements PaymentProvider<never> {
  readonly id = 'stripe-test' as const;

  constructor(secretKey: string) {
    if (!secretKey.startsWith('sk_test_')) throw new Error('StripeTestMode accepts only test-mode keys (sk_test_…)');
  }

  async createPaymentRequest(_input: PaymentInput): Promise<never> {
    throw new Error('Stripe test mode is not implemented yet; the MVP settles in Solana USDC on devnet');
  }

  async verifyPayment(_request: never, _evidence: PaymentEvidence): Promise<never> {
    throw new Error('Stripe test mode is not implemented yet; the MVP settles in Solana USDC on devnet');
  }
}
