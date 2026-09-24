/**
 * HCRN / HCSI identifiers (HCS 1.0 Draft §4.1): `<PREFIX>-XXXX-XXXX-C`.
 *
 * The payload is eight canonical Crockford Base32 symbols (40 bits). `C` is the Crockford
 * check symbol: the payload's numeric value modulo 37, drawn from the payload alphabet plus
 * the check-only symbols `*~$=U`. The draft names the Crockford check symbol but does not spell
 * out the arithmetic; this follows https://www.crockford.com/base32.html.
 *
 * Syntactic validity does not mean an identifier was officially assigned (§4.1). Grantmark's
 * mock registry only issues identifiers from the reserved test range (§4.6).
 */

export type HcsIdPrefix = 'HCRN' | 'HCSI';

export const PAYLOAD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CHECK_ALPHABET = `${PAYLOAD_ALPHABET}*~$=U`;

const PAYLOAD_LENGTH = 8;
const MAX_PAYLOAD_VALUE = 2 ** 40 - 1;

/** Payloads `0000-0000` through `0000-00ZZ` are reserved for examples and testing (§4.6). */
export const RESERVED_TEST_MAX_VALUE = 1023;

// Canonical form only: uppercase, hyphens in place, no surrounding whitespace (§4.1 forbids
// case folding and ambiguous-character decoding).
const ID_SHAPE = /^([A-Z]{4})-([0-9A-Z]{4})-([0-9A-Z]{4})-([0-9A-Z*~$=])$/;

export type HcsIdError = 'format' | 'prefix' | 'payload_symbol' | 'check_symbol';

export type ParsedHcsId =
  | { ok: true; prefix: HcsIdPrefix; payload: string; value: number; check: string }
  | { ok: false; error: HcsIdError };

function payloadValue(payload: string): number {
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new RangeError(`payload must be ${PAYLOAD_LENGTH} symbols, got ${payload.length}`);
  }
  let value = 0;
  for (const symbol of payload) {
    const digit = PAYLOAD_ALPHABET.indexOf(symbol);
    if (digit === -1) throw new RangeError(`not a canonical payload symbol: ${symbol}`);
    value = value * 32 + digit;
  }
  return value;
}

/** Check symbol for an eight-symbol payload without hyphens. */
export function checkSymbol(payload: string): string {
  return CHECK_ALPHABET[payloadValue(payload) % 37]!;
}

export function formatHcsId(prefix: HcsIdPrefix, value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PAYLOAD_VALUE) {
    throw new RangeError(`payload value must be an integer in 0..${MAX_PAYLOAD_VALUE}`);
  }
  let payload = '';
  for (let rest = value, i = 0; i < PAYLOAD_LENGTH; i++, rest = Math.floor(rest / 32)) {
    payload = PAYLOAD_ALPHABET[rest % 32] + payload;
  }
  return `${prefix}-${payload.slice(0, 4)}-${payload.slice(4)}-${checkSymbol(payload)}`;
}

export function parseHcsId(id: string): ParsedHcsId {
  const match = ID_SHAPE.exec(id);
  if (!match) return { ok: false, error: 'format' };
  const [, prefix = '', high = '', low = '', check = ''] = match;

  if (prefix !== 'HCRN' && prefix !== 'HCSI') return { ok: false, error: 'prefix' };

  const payload = high + low;
  if ([...payload].some((symbol) => !PAYLOAD_ALPHABET.includes(symbol))) {
    return { ok: false, error: 'payload_symbol' };
  }
  if (checkSymbol(payload) !== check) return { ok: false, error: 'check_symbol' };

  return { ok: true, prefix, payload, value: payloadValue(payload), check };
}

export function isValidHcsId(id: string, prefix?: HcsIdPrefix): boolean {
  const parsed = parseHcsId(id);
  return parsed.ok && (prefix === undefined || parsed.prefix === prefix);
}

export function isReservedTestId(id: string): boolean {
  const parsed = parseHcsId(id);
  return parsed.ok && parsed.value <= RESERVED_TEST_MAX_VALUE;
}
