/**
 * License requests and issued licenses. A request records exactly what a client asked for; a
 * license is issued at most once per request (a unique constraint), which makes issuance
 * idempotent when payment callbacks or retries arrive more than once.
 */

import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../ids';

export type RequestState = 'open' | 'requires_payment' | 'licensed';

export interface NewLicenseRequest {
  readonly clientId: string;
  readonly hcrn: string;
  readonly hcsi: string;
  readonly declarationSha256: string;
  /** The offer exactly as published in the declaration. */
  readonly licenseXml: string;
  /** 1-based position of the offer in the declaration. */
  readonly licenseIndex: number;
  readonly usage: readonly string[];
  readonly subjectScope: readonly string[];
  readonly place?: string | undefined;
  readonly amount?: { readonly value: string; readonly currency: string } | undefined;
}

export interface LicenseRequest extends NewLicenseRequest {
  readonly id: string;
  readonly state: RequestState;
  readonly createdAt: Date;
}

export interface License {
  readonly id: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly hcrn: string;
  readonly hcsi: string;
  readonly usage: readonly string[];
  readonly subjectScope: readonly string[];
  readonly place?: string | undefined;
  readonly licenseXml: string;
  readonly declarationSha256: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly status: 'active' | 'revoked';
  readonly createdAt: Date;
}

type Row = Record<string, unknown>;

const list = (value: unknown) => (value === null || value === undefined || value === '' ? [] : String(value).split(' '));
const optional = (value: unknown) => (value === null || value === undefined ? undefined : String(value));

function toRequest(row: Row): LicenseRequest {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    hcrn: String(row.hcrn),
    hcsi: String(row.hcsi),
    declarationSha256: String(row.declaration_sha256),
    licenseXml: String(row.license_xml),
    licenseIndex: Number(row.license_index),
    usage: list(row.usage),
    subjectScope: list(row.subject_scope),
    place: optional(row.place),
    amount: row.amount_value === null || row.amount_value === undefined ? undefined : { value: String(row.amount_value), currency: String(row.amount_currency) },
    state: String(row.state) as RequestState,
    createdAt: new Date(String(row.created_at)),
  };
}

function toLicense(row: Row): License {
  return {
    id: String(row.id),
    requestId: String(row.license_request_id),
    clientId: String(row.client_id),
    hcrn: String(row.hcrn),
    hcsi: String(row.hcsi),
    usage: list(row.usage),
    subjectScope: list(row.subject_scope),
    place: optional(row.place),
    licenseXml: String(row.license_xml),
    declarationSha256: String(row.declaration_sha256),
    validFrom: new Date(String(row.valid_from)),
    validUntil: new Date(String(row.valid_until)),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: new Date(String(row.created_at)),
  };
}

export interface Issuance {
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly usage: readonly string[];
  readonly subjectScope: readonly string[];
  readonly declarationSha256: string;
}

export class LicenseStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  createRequest(input: NewLicenseRequest): LicenseRequest {
    const now = this.now();
    const id = newId('lrq', now.getTime());
    this.db
      .prepare(
        `INSERT INTO license_requests (id, client_id, hcrn, hcsi, declaration_sha256, license_xml, license_index, usage,
           subject_scope, place, amount_value, amount_currency, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.clientId,
        input.hcrn,
        input.hcsi,
        input.declarationSha256,
        input.licenseXml,
        input.licenseIndex,
        input.usage.join(' '),
        input.subjectScope.join(' '),
        input.place ?? null,
        input.amount?.value ?? null,
        input.amount?.currency ?? null,
        input.amount === undefined ? 'open' : 'requires_payment',
        now.toISOString(),
        now.toISOString(),
      );
    return this.request(id)!;
  }

  request(id: string): LicenseRequest | undefined {
    const row = this.db.prepare('SELECT * FROM license_requests WHERE id = ?').get(id) as Row | undefined;
    return row && toRequest(row);
  }

  requestCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM license_requests').get() as { n: number }).n);
  }

  /** Issues the license for a request, or returns the one already issued. */
  issue(requestId: string, issuance: Issuance): License {
    const existing = this.licenseForRequest(requestId);
    if (existing !== undefined) return existing;
    const request = this.request(requestId);
    if (request === undefined) throw new Error(`unknown license request ${requestId}`);

    const now = this.now();
    const id = newId('lic', now.getTime());
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO licenses (id, license_request_id, client_id, hcrn, hcsi, usage, subject_scope, place, license_xml,
             declaration_sha256, valid_from, valid_until, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          requestId,
          request.clientId,
          request.hcrn,
          request.hcsi,
          issuance.usage.join(' '),
          issuance.subjectScope.join(' '),
          request.place ?? null,
          request.licenseXml,
          issuance.declarationSha256,
          issuance.validFrom.toISOString(),
          issuance.validUntil.toISOString(),
          now.toISOString(),
        );
      this.db
        .prepare("UPDATE license_requests SET state = 'licensed', updated_at = ? WHERE id = ?")
        .run(now.toISOString(), requestId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.license(id)!;
  }

  license(id: string): License | undefined {
    const row = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as Row | undefined;
    return row && toLicense(row);
  }

  licenseForRequest(requestId: string): License | undefined {
    const row = this.db.prepare('SELECT * FROM licenses WHERE license_request_id = ?').get(requestId) as Row | undefined;
    return row && toLicense(row);
  }
}
