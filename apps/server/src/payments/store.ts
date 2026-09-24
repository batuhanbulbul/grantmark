/**
 * Payment and payee storage. A verified transaction can settle only one payment (a unique
 * constraint on provider and transaction), and a license request only one successful payment.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { PaymentStatus, Receipt, SolanaPaymentRequest } from '@grantmark/payments';

export interface StoredPayment {
  readonly id: string;
  readonly licenseRequestId: string;
  readonly clientId: string;
  readonly provider: 'solana-usdc-devnet';
  readonly status: PaymentStatus;
  readonly request: SolanaPaymentRequest;
  /** The last transaction signature the client reported. */
  readonly reportedSignature?: string | undefined;
  /** The verified transaction, once the payment succeeded. */
  readonly externalRef?: string | undefined;
  readonly receipt?: Receipt | undefined;
  readonly reason?: string | undefined;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

type Row = Record<string, unknown>;
const optional = (value: unknown) => (typeof value === 'string' ? value : undefined);

function toPayment(row: Row): StoredPayment {
  return {
    id: String(row.id),
    licenseRequestId: String(row.license_request_id),
    clientId: String(row.client_id),
    provider: 'solana-usdc-devnet',
    status: String(row.status) as PaymentStatus,
    request: JSON.parse(String(row.request_json)) as SolanaPaymentRequest,
    reportedSignature: optional(row.reported_signature),
    externalRef: optional(row.external_ref),
    receipt: typeof row.receipt_json === 'string' ? (JSON.parse(row.receipt_json) as Receipt) : undefined,
    reason: optional(row.reason),
    expiresAt: new Date(String(row.expires_at)),
    createdAt: new Date(String(row.created_at)),
  };
}

export class PaymentStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  create(input: { id: string; licenseRequestId: string; clientId: string; request: SolanaPaymentRequest; expiresAt: Date }): StoredPayment {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO payments (id, license_request_id, client_id, provider, status, request_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'requires_payment', ?, ?, ?, ?)`,
      )
      .run(input.id, input.licenseRequestId, input.clientId, input.request.provider, JSON.stringify(input.request), input.expiresAt.toISOString(), now, now);
    return this.get(input.id)!;
  }

  get(id: string): StoredPayment | undefined {
    const row = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
    return row && toPayment(row);
  }

  /** Payments that may still be paid or finalized. */
  open(): StoredPayment[] {
    return (this.db.prepare("SELECT * FROM payments WHERE status IN ('requires_payment', 'processing') ORDER BY created_at").all() as Row[]).map(toPayment);
  }

  update(
    id: string,
    change: { status?: PaymentStatus; reportedSignature?: string | undefined; reason?: string | undefined; request?: SolanaPaymentRequest },
  ): StoredPayment {
    const current = this.get(id);
    if (current === undefined) throw new Error(`unknown payment ${id}`);
    this.db
      .prepare('UPDATE payments SET status = ?, reported_signature = ?, reason = ?, request_json = ?, updated_at = ? WHERE id = ?')
      .run(
        change.status ?? current.status,
        change.reportedSignature ?? current.reportedSignature ?? null,
        change.reason ?? null,
        JSON.stringify(change.request ?? current.request),
        this.now().toISOString(),
        id,
      );
    return this.get(id)!;
  }

  /** Records the verified transaction; throws if it already settled another payment. */
  markSucceeded(id: string, externalRef: string, receipt: Receipt): StoredPayment {
    this.db
      .prepare(
        `UPDATE payments SET status = 'succeeded', external_ref = ?, reported_signature = ?, receipt_json = ?, reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(externalRef, externalRef, JSON.stringify(receipt), this.now().toISOString(), id);
    return this.get(id)!;
  }
}

export class PayeeStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  setRightsHolderWallet(hcrn: string, wallet: string): void {
    this.db
      .prepare(
        `INSERT INTO payees (hcrn, role, wallet) VALUES (?, 'rights_holder', ?)
         ON CONFLICT (hcrn, role) DO UPDATE SET wallet = excluded.wallet`,
      )
      .run(hcrn, wallet);
  }

  rightsHolderWallet(hcrn: string): string | undefined {
    const row = this.db.prepare("SELECT wallet FROM payees WHERE hcrn = ? AND role = 'rights_holder'").get(hcrn) as
      | { wallet: string }
      | undefined;
    return row?.wallet;
  }
}
