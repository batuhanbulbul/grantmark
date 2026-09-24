/**
 * The public license record: what stamped images point to as their consent authority. It
 * answers the minimum set CAWG recommends for a consent authority: who declared, what is
 * granted, scope, compensation, term, current status and revocability, and the binding to the
 * assets and the subject. It is public and grants nothing.
 */

import { CANONICAL_ID_BASE } from '@grantmark/hcs';
import type { Config } from '../config';
import type { License, LicenseStore } from '../olp/licenses';
import type { LicenseService } from '../olp/service';
import type { PaymentStore } from '../payments/store';
import type { RegistryStore } from '../registry/store';
import { declarationUrl, subjectRecordUrl } from '../registry/view';

export const REVOCABILITY =
  'The rights holder can withdraw or change the declaration at any time. From then on new uses are no longer ' +
  'permitted (HCS 1.0 Draft §1.3); uses made before stay licensed as of their time.';

export interface RecordServices {
  readonly registry: RegistryStore;
  readonly licenses: LicenseStore;
  readonly licensing: LicenseService;
  readonly payments: PaymentStore;
}

export type LicenseStatus = 'active' | 'expired' | 'revoked';

export function licenseStatus(license: License, now: Date): LicenseStatus {
  if (license.status === 'revoked') return 'revoked';
  return now >= license.validUntil ? 'expired' : 'active';
}

export const explorerUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export function licenseRecord(services: RecordServices, config: Config, now: Date, license: License) {
  const { registry, licenses, licensing, payments } = services;
  const base = config.publicBaseUrl;
  const status = licenseStatus(license, now);
  const request = licenses.request(license.requestId);
  const payment = payments.succeededForRequest(license.requestId);
  const declaration = registry.declaration(license.hcrn);
  const subject = registry.subject(license.hcsi)?.record as { name?: unknown } | undefined;
  const refusal = status === 'active' ? licensing.checkCurrent(license) : undefined;

  return {
    license_id: license.id,
    status,
    current_permission:
      status !== 'active'
        ? { permitted: false, reason: `the license is ${status}` }
        : refusal === undefined
          ? { permitted: true }
          : { permitted: false, reason: refusal.description },
    declaring_party: {
      registry: declaration?.registry,
      hcrn: license.hcrn,
      declaration_url: declarationUrl(base, license.hcrn),
      declaration_uri: CANONICAL_ID_BASE + license.hcrn,
      declaration_sha256: license.declarationSha256,
      rights_subject: {
        hcsi: license.hcsi,
        name: typeof subject?.name === 'string' ? subject.name : undefined,
        record_url: subjectRecordUrl(base, license.hcsi),
      },
    },
    licensee: { client_id: license.clientId },
    grant: {
      usage: license.usage,
      subject_scope: license.subjectScope,
      ...(license.place === undefined ? {} : { place: license.place }),
      license: license.licenseXml,
    },
    compensation: {
      amount: request?.amount ?? null,
      payment:
        payment?.externalRef === undefined
          ? null
          : {
              provider: payment.provider,
              network: payment.request.network,
              asset: payment.request.asset,
              transaction_signature: payment.externalRef,
              explorer_url: explorerUrl(payment.externalRef),
              memo: payment.request.memo,
              paid_to: payment.request.splits.map((s) => ({ role: s.role, wallet: s.wallet, amount: s.amount })),
            },
    },
    term: { valid_from: license.validFrom.toISOString(), valid_until: license.validUntil.toISOString() },
    revocability: REVOCABILITY,
    binding: {
      subject: license.hcsi,
      assets: licenses.assets(license.id).map((a) => ({ sha256: a.sha256, mime: a.mime, mode: a.mode, stamped_at: a.createdAt.toISOString() })),
    },
    receipt_url: `${base}/v1/licenses/${license.id}/receipt`,
    notice: 'Grantmark prototype on the HCS 1.0 Draft. Devnet and test mode only; all people are fictional.',
  };
}

export type LicenseRecord = ReturnType<typeof licenseRecord>;
