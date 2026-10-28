/**
 * base64url (RFC 4648 §5, no padding), SHA-256 digests and RFC 3339 instants as the profile
 * uses them.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from './jcs';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Strict decoding: only the canonical encoding of some octets is accepted (no padding, no
 * other characters, zero padding bits), so each value has exactly one text form.
 */
export function fromBase64url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new RangeError('not base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new RangeError('not the canonical base64url encoding');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function sha256(data: Uint8Array | string): string {
  return base64url(createHash('sha256').update(data).digest());
}

/** The profile's digest: base64url(SHA-256(UTF-8(JCS(value)))). */
export function digestOf(value: unknown): string {
  return sha256(canonicalize(value));
}

/** A salted commitment: the digest of `[salt, value]`. */
export function commitmentDigest(salt: string, value: unknown): string {
  return digestOf([salt, value]);
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Milliseconds since the epoch for a profile `dateTime` (UTC, at most milliseconds, no leap
 * seconds, year 0001 or later). Throws a RangeError for anything else, impossible dates
 * such as 30 February included.
 */
export function instant(text: string): number {
  const time = parseInstant(text);
  if (time === undefined) throw new RangeError(`not a valid UTC date-time: ${text}`);
  return time;
}

/**
 * Like `instant`, without the exception: rule checks call it on many strings that are not
 * dates.
 */
export function isInstant(text: string): boolean {
  return parseInstant(text) !== undefined;
}

function parseInstant(text: string): number | undefined {
  const m = DATE_TIME.exec(text);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millis = Number((m[7] ?? '').padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const valid =
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  return valid ? date.getTime() : undefined;
}

/**
 * The instant `years` later in UTC; from 29 February to 28 February when the target year has
 * none (R4).
 */
export function plusYears(time: number, years: number): number {
  const date = new Date(time);
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  let day = date.getUTCDate();
  if (month === 1 && day === 29 && !isLeapYear(year)) day = 28;
  date.setUTCFullYear(year, month, day);
  return date.getTime();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** An instant as RFC 3339 text, for messages. */
export function iso(time: number): string {
  return new Date(time).toISOString();
}
