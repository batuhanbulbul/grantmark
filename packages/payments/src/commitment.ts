/**
 * The payment commitment: a JSON object with the license terms a payment is for, hashed into the
 * on-chain memo. The memo holds only the hash, so no personal data goes on-chain, while anyone
 * holding the commitment (for example from a receipt) can check it against the memo.
 */

import { createHash } from 'node:crypto';

/**
 * JSON Canonicalization Scheme (RFC 8785) for the values commitments use: objects with keys
 * sorted by UTF-16 code units, arrays, strings, finite numbers, booleans and null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot hold a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

export const MEMO_PREFIX = 'gm1:';

/** `gm1:` followed by the base64url SHA-256 of the commitment's canonical JSON (47 bytes). */
export function commitmentMemo(commitment: Readonly<Record<string, unknown>>): string {
  return MEMO_PREFIX + createHash('sha256').update(canonicalJson(commitment)).digest('base64url');
}
