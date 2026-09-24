/**
 * Storage for the mock HCS registry: registries (with mock Governance Board authorization),
 * Rights Subject Records, versioned declarations and Subject Class membership.
 *
 * Declarations are kept as the exact bytes published, with every version, because HCS needs the
 * terms published for an HCRN at a given time (§4.3.3) and the first-publication time of the
 * current version (§3.1.7.2).
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CANONICAL_ID_BASE, checkDocument, isValidHcsId, parseHcsDocument } from '@grantmark/hcs';

export type PublishErrorCode =
  | 'invalid_declaration'
  | 'unknown_registry'
  | 'subject_changed'
  | 'registry_changed'
  | 'invalid_subject_record';

export class PublishError extends Error {
  readonly code: PublishErrorCode;
  constructor(code: PublishErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoredRegistry {
  readonly url: string;
  readonly name: string;
  readonly authorized: boolean;
  readonly territory?: readonly string[] | undefined;
}

export interface StoredSubject {
  readonly hcsi: string;
  readonly status: 'active' | 'inactive';
  readonly record: unknown;
}

export interface StoredDeclaration {
  readonly hcrn: string;
  readonly version: number;
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly registry: string;
  readonly subjectHcsi?: string | undefined;
  readonly subjectClass?: string | undefined;
  readonly firstPublishedAt: Date;
}

export interface PublishResult {
  readonly hcrn: string;
  readonly version: number;
  /** False when the content equals the current version, so nothing was stored. */
  readonly changed: boolean;
}

export interface StoredEvent {
  readonly at: Date;
  readonly type: string;
  readonly subject?: string | undefined;
  readonly data: unknown;
}

interface DeclarationRow {
  hcrn: string;
  version: number;
  content: Uint8Array;
  sha256: string;
  registry_url: string;
  subject_hcsi: string | null;
  subject_class: string | null;
  first_published_at: string;
}

const toDeclaration = (row: DeclarationRow): StoredDeclaration => ({
  hcrn: row.hcrn,
  version: row.version,
  content: row.content,
  sha256: row.sha256,
  registry: row.registry_url,
  subjectHcsi: row.subject_hcsi ?? undefined,
  subjectClass: row.subject_class ?? undefined,
  firstPublishedAt: new Date(row.first_published_at),
});

const CURRENT = `
  SELECT d.* FROM declarations d
  WHERE d.version = (SELECT MAX(version) FROM declarations WHERE hcrn = d.hcrn)`;

/** Current versions, in the order their HCRNs were first published. */
const CURRENT_IN_ORDER = `${CURRENT} ORDER BY (SELECT MIN(id) FROM declarations WHERE hcrn = d.hcrn)`;

export class RegistryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  putRegistry(registry: StoredRegistry): void {
    this.db
      .prepare(
        `INSERT INTO registries (url, name, authorized, territory) VALUES (?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET name = excluded.name, authorized = excluded.authorized, territory = excluded.territory`,
      )
      .run(registry.url, registry.name, registry.authorized ? 1 : 0, registry.territory?.join(' ') ?? null);
  }

  registry(url: string): StoredRegistry | undefined {
    const row = this.db.prepare('SELECT * FROM registries WHERE url = ?').get(url);
    return row && this.toRegistry(row as Record<string, unknown>);
  }

  registries(): StoredRegistry[] {
    return (this.db.prepare('SELECT * FROM registries ORDER BY rowid').all() as Record<string, unknown>[]).map((row) =>
      this.toRegistry(row),
    );
  }

  private toRegistry(row: Record<string, unknown>): StoredRegistry {
    return {
      url: String(row.url),
      name: String(row.name),
      authorized: row.authorized === 1,
      territory: typeof row.territory === 'string' ? row.territory.split(' ') : undefined,
    };
  }

  /** Stores a Rights Subject Record under the HCSI in its canonical `@id`; returns the HCSI. */
  putSubject(record: unknown, status: 'active' | 'inactive' = 'active'): string {
    const id = typeof record === 'object' && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>)['@id'] : undefined;
    const hcsi = typeof id === 'string' && id.startsWith(CANONICAL_ID_BASE) ? id.slice(CANONICAL_ID_BASE.length) : '';
    if (!isValidHcsId(hcsi, 'HCSI')) {
      throw new PublishError('invalid_subject_record', 'a Rights Subject Record needs a canonical HCSI URI as @id');
    }
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO rights_subjects (hcsi, status, record_jsonld, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (hcsi) DO UPDATE SET status = excluded.status, record_jsonld = excluded.record_jsonld, updated_at = excluded.updated_at`,
      )
      .run(hcsi, status, JSON.stringify(record), now, now);
    return hcsi;
  }

  subject(hcsi: string): StoredSubject | undefined {
    const row = this.db.prepare('SELECT * FROM rights_subjects WHERE hcsi = ?').get(hcsi) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      hcsi: String(row.hcsi),
      status: row.status === 'inactive' ? 'inactive' : 'active',
      record: JSON.parse(String(row.record_jsonld)),
    };
  }

  /**
   * Publishes a document holding exactly one conforming `<hcs:right>`. Identical content to the
   * current version is not stored again.
   */
  publish(content: string | Uint8Array): PublishResult {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const parsed = parseHcsDocument(bytes);
    if (!parsed.ok) throw new PublishError('invalid_declaration', `not a readable HCS document: ${parsed.error.message}`);
    if (parsed.document.rights.length !== 1) {
      throw new PublishError('invalid_declaration', 'the mock registry stores exactly one <hcs:right> per document');
    }
    const [check] = checkDocument(parsed.document);
    const declaration = check?.declaration;
    if (declaration === undefined) {
      const reasons = (check?.reasons ?? []).map((r) => `${r.rule} ${r.at}: ${r.message}`).join('; ');
      throw new PublishError('invalid_declaration', `the declaration does not conform: ${reasons}`);
    }
    const { registrationId: hcrn, registry } = declaration;
    if (this.registry(registry) === undefined) {
      throw new PublishError('unknown_registry', `${registry} is not a registry known to this mock network`);
    }

    const current = this.declaration(hcrn);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (current !== undefined) {
      if (current.registry !== registry) {
        throw new PublishError('registry_changed', `${hcrn} belongs to ${current.registry}`);
      }
      if (current.subjectHcsi !== declaration.subjectId || current.subjectClass !== declaration.subjectClass) {
        throw new PublishError('subject_changed', 'a same-HCRN update must keep the same Rights Subject or Subject Class (HCS §3.1.2)');
      }
      if (current.sha256 === sha256) return { hcrn, version: current.version, changed: false };
    }

    const version = (current?.version ?? 0) + 1;
    const now = this.now().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO declarations (hcrn, version, content, sha256, registry_url, subject_hcsi, subject_class, first_published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(hcrn, version, bytes, sha256, registry, declaration.subjectId ?? null, declaration.subjectClass ?? null, now);
      this.addEvent('declaration_published', hcrn, { version, sha256, status: declaration.status });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { hcrn, version, changed: true };
  }

  /** The current version of a declaration. */
  declaration(hcrn: string): StoredDeclaration | undefined {
    const row = this.db.prepare(`${CURRENT} AND d.hcrn = ?`).get(hcrn);
    return row && toDeclaration(row as unknown as DeclarationRow);
  }

  /** Current versions of all declarations, in order of first publication. */
  declarations(): StoredDeclaration[] {
    return (this.db.prepare(CURRENT_IN_ORDER).all() as unknown as DeclarationRow[]).map(toDeclaration);
  }

  /** Every version of a declaration, oldest first. */
  history(hcrn: string): StoredDeclaration[] {
    return (this.db.prepare('SELECT * FROM declarations WHERE hcrn = ? ORDER BY version').all(hcrn) as unknown as DeclarationRow[]).map(
      toDeclaration,
    );
  }

  /** Current declarations for a subject, plus every current Default Declaration. */
  declarationsFor(hcsi: string): StoredDeclaration[] {
    return this.declarations().filter((d) => d.subjectHcsi === hcsi || d.subjectClass !== undefined);
  }

  addMember(subjectClass: string, hcsi: string): void {
    this.db.prepare('INSERT OR IGNORE INTO subject_class_members (subject_class, hcsi) VALUES (?, ?)').run(subjectClass, hcsi);
  }

  isMember(subjectClass: string, hcsi: string): boolean {
    return this.db.prepare('SELECT 1 FROM subject_class_members WHERE subject_class = ? AND hcsi = ?').get(subjectClass, hcsi) !== undefined;
  }

  events(): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[]).map((row) => ({
      at: new Date(String(row.at)),
      type: String(row.type),
      subject: typeof row.subject === 'string' ? row.subject : undefined,
      data: JSON.parse(String(row.data)),
    }));
  }

  private addEvent(type: string, subject: string | undefined, data: unknown): void {
    this.db
      .prepare('INSERT INTO events (at, type, subject, data) VALUES (?, ?, ?, ?)')
      .run(this.now().toISOString(), type, subject ?? null, JSON.stringify(data));
  }
}
