import { describe, expect, it } from 'vitest';
import { newId, ulid } from '../src/ids';

describe('ulid', () => {
  it('is 26 Crockford Base32 characters', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('encodes the time first, so later ids sort after earlier ones', () => {
    const early = ulid(Date.UTC(2026, 8, 1));
    const late = ulid(Date.UTC(2026, 9, 1));
    expect(early < late).toBe(true);
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26));
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(Date.UTC(2026, 8, 1))));
    expect(ids.size).toBe(1000);
  });
});

describe('newId', () => {
  it('prefixes a ULID', () => {
    expect(newId('lic')).toMatch(/^lic_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
