import { describe, expect, it } from 'vitest';
import { EU_MEMBER_STATES, ISO_3166_ALPHA_2, expandGeo, isCountryCode } from '../src/countries';

describe('ISO 3166-1 alpha-2 codes', () => {
  it('lists the 249 officially assigned codes', () => {
    expect(ISO_3166_ALPHA_2.size).toBe(249);
    for (const code of ['TR', 'US', 'DE', 'FR', 'GB', 'NA', 'AX', 'SS', 'BQ']) {
      expect(isCountryCode(code), code).toBe(true);
    }
  });

  it.each([
    ['user-assigned XK (Kosovo)', 'XK'],
    ['exceptionally reserved EU', 'EU'],
    ['exceptionally reserved UK', 'UK'],
    ['transitionally reserved AN', 'AN'],
    ['user-assigned ZZ', 'ZZ'],
    ['lowercase', 'tr'],
  ])('rejects %s', (_label, code) => {
    expect(isCountryCode(code)).toBe(false);
  });
});

describe('RSL geo tokens', () => {
  it('lists the 27 EU member states, all valid country codes', () => {
    expect(EU_MEMBER_STATES).toHaveLength(27);
    for (const code of EU_MEMBER_STATES) expect(isCountryCode(code), code).toBe(true);
    expect(EU_MEMBER_STATES).not.toContain('GB');
  });

  it('expands EU to its member states and keeps country codes', () => {
    const expanded = expandGeo(['EU', 'US', 'DE']);
    expect(expanded.has('US')).toBe(true);
    expect(expanded.has('FR')).toBe(true);
    expect(expanded.has('EU')).toBe(false);
    expect(expanded.size).toBe(28);
  });
});
