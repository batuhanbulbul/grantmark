/**
 * SQLite storage through Node's built-in `node:sqlite`, with numbered migrations.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'mock registry',
    sql: `
      CREATE TABLE registries (
        url TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        authorized INTEGER NOT NULL CHECK (authorized IN (0, 1)),
        territory TEXT -- space-separated ISO 3166-1 codes; NULL when not limited
      );

      CREATE TABLE rights_subjects (
        hcsi TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        record_jsonld TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Every published version of every declaration; the highest version is current.
      CREATE TABLE declarations (
        id INTEGER PRIMARY KEY,
        hcrn TEXT NOT NULL,
        version INTEGER NOT NULL,
        content BLOB NOT NULL, -- the exact bytes as published
        sha256 TEXT NOT NULL,
        registry_url TEXT NOT NULL REFERENCES registries (url),
        subject_hcsi TEXT,
        subject_class TEXT,
        first_published_at TEXT NOT NULL,
        UNIQUE (hcrn, version),
        CHECK ((subject_hcsi IS NULL) <> (subject_class IS NULL))
      );
      CREATE INDEX declarations_by_subject ON declarations (subject_hcsi);

      CREATE TABLE subject_class_members (
        subject_class TEXT NOT NULL,
        hcsi TEXT NOT NULL,
        PRIMARY KEY (subject_class, hcsi)
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT,
        data TEXT NOT NULL
      );
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `,
  },
  {
    id: 2,
    name: 'license server',
    sql: `
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL, -- scrypt; the secret itself is never stored
        created_at TEXT NOT NULL
      );

      CREATE TABLE signing_keys (
        kid TEXT PRIMARY KEY,
        private_jwk TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      );

      CREATE TABLE license_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients (client_id),
        hcrn TEXT NOT NULL,
        hcsi TEXT NOT NULL,
        declaration_sha256 TEXT NOT NULL,
        license_xml TEXT NOT NULL, -- the offer as published
        license_index INTEGER NOT NULL,
        usage TEXT NOT NULL,
        subject_scope TEXT NOT NULL,
        place TEXT,
        amount_value TEXT,
        amount_currency TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'requires_payment', 'licensed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE licenses (
        id TEXT PRIMARY KEY,
        license_request_id TEXT NOT NULL UNIQUE REFERENCES license_requests (id),
        client_id TEXT NOT NULL REFERENCES clients (client_id),
        hcrn TEXT NOT NULL,
        hcsi TEXT NOT NULL,
        usage TEXT NOT NULL,
        subject_scope TEXT NOT NULL,
        place TEXT,
        license_xml TEXT NOT NULL,
        declaration_sha256 TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: 'payments',
    sql: `
      -- Rights holder wallets per declaration; the operator fee wallet comes from configuration.
      CREATE TABLE payees (
        hcrn TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('rights_holder')),
        wallet TEXT NOT NULL,
        PRIMARY KEY (hcrn, role)
      );

      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        license_request_id TEXT NOT NULL REFERENCES license_requests (id),
        client_id TEXT NOT NULL REFERENCES clients (client_id),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'expired')),
        request_json TEXT NOT NULL,
        reported_signature TEXT,
        external_ref TEXT, -- the verified transaction; one payment per transaction
        receipt_json TEXT,
        reason TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, external_ref)
      );
      CREATE UNIQUE INDEX payments_one_success_per_request ON payments (license_request_id) WHERE status = 'succeeded';
    `,
  },
];

/** Applies pending migrations in order, each in its own transaction. Returns how many ran. */
export function migrate(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    count++;
  }
  return count;
}

/** Opens (or creates) the database, enables foreign keys and applies migrations. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}
