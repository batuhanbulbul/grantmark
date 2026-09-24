/**
 * OLP client credentials (RSL §5.3). Every OLP endpoint requires HTTP Basic authentication with a
 * `client_id` and `client_secret` issued by the operator. Secrets are stored as scrypt hashes.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../ids';

export interface Client {
  readonly clientId: string;
  readonly name: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function secretMatches(secret: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(secret, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

/** Checked against when the client is unknown, so both cases take the same time. */
let dummyHash: string | undefined;

export class ClientStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** Registers a client. The secret is returned once and only its hash is kept. */
  create(name: string, options: { clientId?: string; secret?: string } = {}): { clientId: string; clientSecret: string } {
    const clientId = options.clientId ?? newId('cli');
    const clientSecret = options.secret ?? randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO clients (client_id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, name, hashSecret(clientSecret), this.now().toISOString());
    return { clientId, clientSecret };
  }

  get(clientId: string): Client | undefined {
    const row = this.db.prepare('SELECT client_id, name FROM clients WHERE client_id = ?').get(clientId) as
      | { client_id: string; name: string }
      | undefined;
    return row && { clientId: row.client_id, name: row.name };
  }

  verify(clientId: string, secret: string): Client | undefined {
    const row = this.db.prepare('SELECT client_id, name, secret_hash FROM clients WHERE client_id = ?').get(clientId) as
      | { client_id: string; name: string; secret_hash: string }
      | undefined;
    dummyHash ??= hashSecret('unknown client');
    const matches = secretMatches(secret, row?.secret_hash ?? dummyHash);
    return row !== undefined && matches ? { clientId: row.client_id, name: row.name } : undefined;
  }
}

/**
 * Reads `Authorization: Basic …` (RFC 7617). RSL §5.3.1 and RFC 6749 §2.3.1 form-encode the
 * client id (and RFC 6749 also the secret) before joining them with a colon.
 */
export function parseBasicAuth(header: string | undefined): { clientId: string; secret: string } | undefined {
  const match = /^basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? '');
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return undefined;
  const formDecode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
  try {
    return { clientId: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}
