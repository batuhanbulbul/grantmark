/** Prefixed ULIDs (e.g. `lic_01J9…`): time-ordered, 26 Crockford Base32 characters. */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 48 bits of milliseconds followed by 80 random bits. */
export function ulid(time = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let timePart = '';
  for (let rest = time, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) {
    timePart = ALPHABET[rest % 32] + timePart;
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let randomPart = '';
  for (let i = 0; i < 16; i++, bits >>= 5n) {
    randomPart = ALPHABET[Number(bits & 31n)] + randomPart;
  }
  return timePart + randomPart;
}

export function newId(prefix: string, time = Date.now()): string {
  return `${prefix}_${ulid(time)}`;
}
