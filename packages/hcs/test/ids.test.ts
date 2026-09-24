import { describe, expect, it } from 'vitest';
import {
  RESERVED_TEST_MAX_VALUE,
  checkSymbol,
  formatHcsId,
  isReservedTestId,
  isValidHcsId,
  parseHcsId,
} from '../src/ids';

// Identifiers that appear in the HCS 1.0 Draft examples. All of them have payload values
// below 32, so their check symbol equals the last payload character.
const SPEC_EXAMPLE_IDS = [
  'HCRN-0000-0000-0',
  'HCRN-0000-0001-1',
  'HCRN-0000-0008-8',
  'HCRN-0000-0009-9',
  'HCRN-0000-000A-A',
  'HCSI-0000-0001-1',
  'HCSI-0000-0002-2',
];

// Computed from the Crockford Base32 definition (value mod 37, check symbols *~$=U for 32..36).
const COMPUTED_VECTORS: Array<[value: number, id: string]> = [
  [31, 'HCSI-0000-000Z-Z'],
  [32, 'HCSI-0000-0010-*'],
  [33, 'HCSI-0000-0011-~'],
  [34, 'HCSI-0000-0012-$'],
  [35, 'HCSI-0000-0013-='],
  [36, 'HCSI-0000-0014-U'],
  [37, 'HCSI-0000-0015-0'],
  [74, 'HCSI-0000-002A-0'],
  [1023, 'HCSI-0000-00ZZ-R'],
  [1024, 'HCSI-0000-0100-S'],
  [1_048_576, 'HCSI-0001-0000-~'],
  [123_456_789, 'HCSI-003N-QK8N-U'],
  [2 ** 39, 'HCSI-G000-0000-8'],
  [2 ** 40 - 1, 'HCSI-ZZZZ-ZZZZ-F'],
];

describe('checkSymbol', () => {
  it('matches the spec examples', () => {
    for (const id of SPEC_EXAMPLE_IDS) {
      const payload = id.slice(5, 9) + id.slice(10, 14);
      expect(checkSymbol(payload)).toBe(id.at(-1));
    }
  });

  it('detects a transposition and a substitution', () => {
    expect(checkSymbol('00000012')).toBe('$');
    expect(checkSymbol('00000021')).toBe('W');
    expect(checkSymbol('0000ABCD')).toBe('E');
    expect(checkSymbol('0000ABDC')).toBe('8');
    expect(checkSymbol('0000ABCE')).toBe('F');
  });

  it('rejects payloads that are not eight canonical symbols', () => {
    expect(() => checkSymbol('0000000')).toThrow();
    expect(() => checkSymbol('0000-0000')).toThrow();
    expect(() => checkSymbol('0000000O')).toThrow();
    expect(() => checkSymbol('0000000u')).toThrow();
  });
});

describe('formatHcsId', () => {
  it.each(COMPUTED_VECTORS)('formats %i as %s', (value, id) => {
    expect(formatHcsId('HCSI', value)).toBe(id);
  });

  it('uses the requested prefix', () => {
    expect(formatHcsId('HCRN', 0)).toBe('HCRN-0000-0000-0');
  });

  it('rejects values outside the 40-bit payload range', () => {
    expect(() => formatHcsId('HCSI', -1)).toThrow(RangeError);
    expect(() => formatHcsId('HCSI', 2 ** 40)).toThrow(RangeError);
    expect(() => formatHcsId('HCSI', 1.5)).toThrow(RangeError);
  });
});

describe('parseHcsId', () => {
  it.each(COMPUTED_VECTORS)('parses %i from %s', (value, id) => {
    const result = parseHcsId(id);
    expect(result).toEqual({
      ok: true,
      prefix: 'HCSI',
      payload: id.slice(5, 9) + id.slice(10, 14),
      value,
      check: id.at(-1),
    });
  });

  it('accepts every spec example id', () => {
    for (const id of SPEC_EXAMPLE_IDS) expect(parseHcsId(id).ok).toBe(true);
  });

  it.each([
    ['hcsi-0000-0001-1', 'format'],
    ['HCSI-00000001-1', 'format'],
    ['HCSI-0000-0001-1 ', 'format'],
    [' HCSI-0000-0001-1', 'format'],
    ['HCSI-0000-0001-', 'format'],
    ['HCXX-0000-0001-1', 'prefix'],
    ['HCSI-0000-000O-0', 'payload_symbol'],
    ['HCSI-0000-00U0-0', 'payload_symbol'],
    ['HCSI-0000-0001-2', 'check_symbol'],
    ['HCSI-0000-0010-U', 'check_symbol'],
  ])('rejects %j (%s)', (input, error) => {
    expect(parseHcsId(input)).toEqual({ ok: false, error });
  });

  it('round-trips random values', () => {
    for (let i = 0; i < 1000; i++) {
      const value = Math.floor(Math.random() * 2 ** 40);
      const id = formatHcsId('HCRN', value);
      const parsed = parseHcsId(id);
      expect(parsed.ok && parsed.value).toBe(value);
    }
  });
});

describe('isValidHcsId', () => {
  it('checks syntax and, optionally, the prefix', () => {
    expect(isValidHcsId('HCRN-0000-0000-0')).toBe(true);
    expect(isValidHcsId('HCRN-0000-0000-0', 'HCRN')).toBe(true);
    expect(isValidHcsId('HCRN-0000-0000-0', 'HCSI')).toBe(false);
    expect(isValidHcsId('HCRN-0000-0000-1')).toBe(false);
  });
});

describe('isReservedTestId', () => {
  it('covers exactly 0000-0000 through 0000-00ZZ (HCS §4.6)', () => {
    expect(RESERVED_TEST_MAX_VALUE).toBe(1023);
    expect(isReservedTestId('HCSI-0000-0000-0')).toBe(true);
    expect(isReservedTestId('HCSI-0000-00ZZ-R')).toBe(true);
    expect(isReservedTestId('HCSI-0000-0100-S')).toBe(false);
  });

  it('is false for invalid identifiers', () => {
    expect(isReservedTestId('HCSI-0000-0000-1')).toBe(false);
  });
});
