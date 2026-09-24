/**
 * The payment step Grantmark adds to OLP: a paid offer gets a payment request, the client pays
 * with its own wallet and retries /olp/token with the transaction signature, and the license is
 * issued once the payment is verified on devnet at finalized commitment. Issuance goes through
 * LicenseService.issue, which re-checks the declaration and the minors rule first.
 *
 * Client callbacks, the poller and retries all settle through the same code path, so repeated
 * or concurrent calls are safe.
 */

import { canonicalLicense } from '@grantmark/hcs';
import {
  isSolanaAddress,
  type PayeeRole,
  type SolanaPaymentRequest,
  type SolanaUsdcDevnet,
  type VerificationResult,
} from '@grantmark/payments';
import type { Config } from '../config';
import { newId } from '../ids';
import type { Client } from '../olp/clients';
import type { LicenseRequest, LicenseStore } from '../olp/licenses';
import { resourceHcrn, type LicenseService, type Refusal, type ReasonCode, type TokenForm, type TokenIssued } from '../olp/service';
import type { PayeeStore, PaymentStore, StoredPayment } from './store';

/** How long a payment request stays open (also x402's `max_timeout_seconds`). */
export const PAYMENT_TIMEOUT_SECONDS = 600;
const EXPIRY_GRACE_MS = 120_000;

export type StartOutcome =
  | { readonly kind: 'needs_payer'; readonly request: LicenseRequest }
  | { readonly kind: 'unavailable'; readonly description: string }
  | { readonly kind: 'payment'; readonly payment: StoredPayment }
  | Refusal;

export type SettleOutcome =
  | TokenIssued
  | { readonly kind: 'pending'; readonly payment: StoredPayment }
  | (Refusal & { readonly payment?: StoredPayment | undefined });

const refuse = (status: 400 | 403, error: Refusal['error'], description: string, reasonCode?: ReasonCode): Refusal => ({
  kind: 'error',
  status,
  error,
  description,
  reasonCode,
});

export class PaymentService {
  private readonly payments: PaymentStore;
  private readonly payees: PayeeStore;
  private readonly licenses: LicenseStore;
  private readonly licensing: LicenseService;
  private readonly provider: SolanaUsdcDevnet;
  private readonly config: Config;
  private readonly now: () => Date;

  constructor(deps: {
    payments: PaymentStore;
    payees: PayeeStore;
    licenses: LicenseStore;
    licensing: LicenseService;
    provider: SolanaUsdcDevnet;
    config: Config;
    now: () => Date;
  }) {
    this.payments = deps.payments;
    this.payees = deps.payees;
    this.licenses = deps.licenses;
    this.licensing = deps.licensing;
    this.provider = deps.provider;
    this.config = deps.config;
    this.now = deps.now;
  }

  /** Creates the payment for a paid license request once the payer's wallet is known. */
  async start(request: LicenseRequest, payer: string | undefined): Promise<StartOutcome> {
    if (payer === undefined) return { kind: 'needs_payer', request };
    if (!isSolanaAddress(payer)) return refuse(400, 'invalid_request', 'payer must be a Solana wallet address (devnet)');
    const wallet = this.payees.rightsHolderWallet(request.hcrn);
    if (wallet === undefined) {
      return refuse(403, 'invalid_license', 'no payee wallet is configured for this rights holder yet', 'payment_unavailable');
    }

    const { operatorWallet, operatorFeeBps } = this.config;
    const payees: { role: PayeeRole; wallet: string; bps: number }[] = [
      { role: 'rights_holder', wallet, bps: 10_000 - operatorFeeBps },
      ...(operatorWallet !== undefined && operatorFeeBps > 0 ? [{ role: 'operator_fee' as const, wallet: operatorWallet, bps: operatorFeeBps }] : []),
    ];
    const now = this.now();
    const id = newId('pay', now.getTime());
    const expiresAt = new Date(now.getTime() + PAYMENT_TIMEOUT_SECONDS * 1000);
    let paymentRequest: SolanaPaymentRequest;
    try {
      paymentRequest = await this.provider.createPaymentRequest({
        paymentId: id,
        licenseRequestId: request.id,
        amount: request.amount!,
        payer,
        payees,
        terms: {
          hcrn: request.hcrn,
          hcsi: request.hcsi,
          usage: request.usage,
          subject_scope: request.subjectScope,
          ...(request.place === undefined ? {} : { place: request.place }),
          client: request.clientId,
        },
        createdAt: now,
        expiresAt,
      });
    } catch (error) {
      console.error('could not build the payment on devnet', error);
      return { kind: 'unavailable', description: 'Solana devnet is not reachable right now; try again shortly.' };
    }
    const payment = this.payments.create({ id, licenseRequestId: request.id, clientId: request.clientId, request: paymentRequest, expiresAt });
    return { kind: 'payment', payment };
  }

  /** Handles a /olp/token retry that carries `payment_id` (and usually `payment_evidence`). */
  async settle(client: Client, form: TokenForm): Promise<SettleOutcome> {
    const payment = form.payment_id === undefined ? undefined : this.payments.get(form.payment_id);
    if (payment === undefined || payment.clientId !== client.clientId) {
      return refuse(400, 'invalid_request', 'payment_id does not name a payment of this client');
    }
    const request = this.licenses.request(payment.licenseRequestId)!;
    const sameTerms =
      form.license !== undefined &&
      form.resource !== undefined &&
      canonicalLicense(form.license) === request.licenseCanonical &&
      resourceHcrn(form.resource) === request.hcrn;
    if (!sameTerms) {
      return refuse(400, 'invalid_request', 'license and resource must be the ones this payment was requested for');
    }
    return this.settleStored(payment, form.payment_evidence);
  }

  /** The payment with a fresh transaction (new blockhash, same memo), for its owner. */
  async refresh(client: Client, id: string): Promise<StoredPayment | undefined> {
    const payment = this.owned(client, id);
    if (payment === undefined || payment.status !== 'requires_payment' || this.now() > payment.expiresAt) return undefined;
    return this.payments.update(id, { request: await this.provider.refreshTransaction(payment.request) });
  }

  owned(client: Client, id: string): StoredPayment | undefined {
    const payment = this.payments.get(id);
    return payment?.clientId === client.clientId ? payment : undefined;
  }

  /**
   * Settles open payments whose transaction was never reported, by scanning for their memo on
   * devnet, and expires stale ones. Returns how many licenses were issued.
   */
  async poll(): Promise<number> {
    let issued = 0;
    for (const payment of this.payments.open()) {
      const stale = this.now().getTime() > payment.expiresAt.getTime() + EXPIRY_GRACE_MS;
      if (payment.reportedSignature === undefined && stale) {
        this.payments.update(payment.id, { status: 'expired', reason: 'the payment request expired unpaid' });
        continue;
      }
      const signature = payment.reportedSignature ?? (await this.provider.findPayment(payment.request).catch(() => undefined));
      if (signature === undefined) continue;
      const outcome = await this.settleStored(payment, signature);
      if (outcome.kind === 'token') issued++;
    }
    return issued;
  }

  private async settleStored(payment: StoredPayment, evidence: string | undefined): Promise<SettleOutcome> {
    if (payment.status === 'succeeded') return this.issue(payment);
    const now = this.now();
    const signature = evidence ?? payment.reportedSignature;
    if (signature === undefined) {
      const expired = now > payment.expiresAt;
      return {
        kind: 'pending',
        payment: this.payments.update(payment.id, {
          status: expired ? 'expired' : payment.status,
          reason: expired ? 'the payment request expired unpaid' : 'no transaction has been reported yet',
        }),
      };
    }

    let result: VerificationResult;
    try {
      result = await this.provider.verifyPayment(payment.request, { signature });
    } catch {
      const reason = 'Solana devnet is unavailable, so the payment could not be checked yet; retry shortly.';
      return { kind: 'pending', payment: this.payments.update(payment.id, { reportedSignature: signature, reason }) };
    }
    if (result.status === 'succeeded' && result.receipt !== undefined) {
      let settled: StoredPayment;
      try {
        settled = this.payments.markSucceeded(payment.id, signature, result.receipt);
      } catch {
        return refuse(400, 'invalid_request', 'this transaction has already settled another payment');
      }
      return this.issue(settled);
    }
    const stale = now.getTime() > payment.expiresAt.getTime() + EXPIRY_GRACE_MS;
    const status =
      result.status === 'failed' || result.status === 'processing' ? result.status : stale ? 'expired' : 'requires_payment';
    return { kind: 'pending', payment: this.payments.update(payment.id, { status, reportedSignature: signature, reason: result.reason }) };
  }

  private async issue(payment: StoredPayment): Promise<SettleOutcome> {
    const r = payment.request;
    const receiptPayment = {
      provider: r.provider,
      network: r.network,
      asset: r.asset,
      transactionSignature: payment.externalRef!,
      amount: this.licenses.request(payment.licenseRequestId)!.amount!,
      memo: r.memo,
      commitment: r.commitment,
      paidAt: payment.receipt?.paidAt ?? this.now().toISOString(),
    };
    const outcome = await this.licensing.issue(payment.licenseRequestId, receiptPayment);
    // A refusal after payment (e.g. the declaration was withdrawn meanwhile) keeps the payment on
    // record for a refund; on devnet that is a manual step.
    return outcome.kind === 'error' ? { ...outcome, payment } : outcome;
  }
}
