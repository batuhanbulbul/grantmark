import { describe, expect, it } from 'vitest';
import { checkDocument, type Declaration } from '../src/conformance';
import { DEFAULT_MAX_AGE_DAYS, checkLifecycle, effectiveMaxAgeDays } from '../src/lifecycle';
import { HCS_NAMESPACE, RSL_NAMESPACE, parseHcsDocument } from '../src/parser';

const HCSI = 'HCSI-0000-0034-T';
const SCHEMA = JSON.stringify({
  '@context': 'https://schema.org',
  '@id': `https://id.humanconsent.org/${HCSI}`,
  '@type': 'Person',
  additionalType: 'https://humanconsent.org/schemas/identity',
  name: 'Test Person',
  identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://example.com/p' }],
});

function declaration(attributes: Record<string, string> = {}, rootAttributes = ''): Declaration {
  const all = {
    registry: 'https://registry.example',
    'registration-id': 'HCRN-0000-0068-F',
    issued: '2026-09-01T00:00:00Z',
    subject: 'identity',
    'subject-id': HCSI,
    ...attributes,
  };
  const attributeText = Object.entries(all)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');
  const xml =
    `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}" ${rootAttributes}>` +
    `<hcs:right ${attributeText}><schema type="application/ld+json">${SCHEMA}</schema>` +
    '<license><permits type="usage">hcs:ai-generate</permits>' +
    '<legal type="attestation">true</legal><legal type="contact">https://registry.example/c</legal>' +
    '</license></hcs:right></rsl>';
  const parsed = parseHcsDocument(xml);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const [check] = checkDocument(parsed.document);
  if (!check?.declaration) throw new Error(JSON.stringify(check?.reasons));
  return check.declaration;
}

const at = (iso: string) => new Date(iso);
const codesAt = (d: Declaration, iso: string, extra: { validatedAt?: Date; availableSince?: Date } = {}) =>
  checkLifecycle(d, { at: at(iso), ...extra }).reasons.map((r) => r.code);

describe('effectiveMaxAgeDays (HCS §3.1.8)', () => {
  it('defaults to 30 days', () => {
    expect(DEFAULT_MAX_AGE_DAYS).toBe(30);
    expect(effectiveMaxAgeDays(declaration())).toBe(30);
  });

  it('uses whichever of <rsl> and <hcs:right> is present, and the smaller of both', () => {
    expect(effectiveMaxAgeDays(declaration({ 'max-age': '7' }))).toBe(7);
    expect(effectiveMaxAgeDays(declaration({}, 'max-age="10"'))).toBe(10);
    expect(effectiveMaxAgeDays(declaration({ 'max-age': '7' }, 'max-age="3"'))).toBe(3);
    expect(effectiveMaxAgeDays(declaration({ 'max-age': '5' }, 'max-age="60"'))).toBe(5);
  });
});

describe('checkLifecycle: status (HCS §3.1.7.1)', () => {
  it('accepts an active declaration in force', () => {
    expect(codesAt(declaration(), '2026-09-15T00:00:00Z')).toEqual([]);
    expect(codesAt(declaration({ status: 'active' }), '2026-09-15T00:00:00Z')).toEqual([]);
  });

  it('fails withdrawn and superseded declarations', () => {
    expect(codesAt(declaration({ status: 'withdrawn' }), '2026-09-15T00:00:00Z')).toEqual(['withdrawn']);
    const superseded = declaration({ status: 'superseded', 'superseded-by': 'HCRN-0000-0069-G' });
    expect(codesAt(superseded, '2026-09-15T00:00:00Z')).toEqual(['superseded']);
  });
});

describe('checkLifecycle: validity period (HCS §3.1.7.2)', () => {
  it('starts at issued when valid-from is absent, inclusively', () => {
    const d = declaration();
    expect(codesAt(d, '2026-08-31T23:59:59.999Z')).toEqual(['not_yet_in_force']);
    expect(codesAt(d, '2026-09-01T00:00:00Z')).toEqual([]);
  });

  it('starts at valid-from when present', () => {
    const d = declaration({ 'valid-from': '2026-09-10T00:00:00Z' });
    expect(codesAt(d, '2026-09-05T00:00:00Z')).toEqual(['not_yet_in_force']);
    expect(codesAt(d, '2026-09-10T00:00:00Z')).toEqual([]);
  });

  it('treats valid-until as exclusive', () => {
    const d = declaration({ 'valid-until': '2026-10-01T00:00:00Z' });
    expect(codesAt(d, '2026-09-30T23:59:59.999Z')).toEqual([]);
    expect(codesAt(d, '2026-10-01T00:00:00Z')).toEqual(['expired']);
  });

  it('compares instants after time zone normalization', () => {
    const d = declaration({ 'valid-until': '2026-10-01T02:00:00+02:00' });
    expect(codesAt(d, '2026-10-01T00:00:00Z')).toEqual(['expired']);
    expect(codesAt(d, '2026-09-30T23:00:00Z')).toEqual([]);
  });

  it('is never in force when valid-from precedes issued', () => {
    const d = declaration({ 'valid-from': '2026-08-01T00:00:00Z' });
    expect(codesAt(d, '2026-09-15T00:00:00Z')).toEqual(['invalid_validity_period']);
  });

  it('is never in force when valid-until is not after the start', () => {
    const same = declaration({ 'valid-until': '2026-09-01T00:00:00Z' });
    expect(codesAt(same, '2026-09-15T00:00:00Z')).toEqual(['invalid_validity_period']);
    const earlier = declaration({ 'valid-from': '2026-09-10T00:00:00Z', 'valid-until': '2026-09-05T00:00:00Z' });
    expect(codesAt(earlier, '2026-09-07T00:00:00Z')).toEqual(['invalid_validity_period']);
  });

  it('starts no earlier than the time the terms were available (first-observation rule)', () => {
    const d = declaration({ 'valid-from': '2026-09-10T00:00:00Z' });
    const availableSince = at('2026-09-12T00:00:00Z');
    expect(codesAt(d, '2026-09-11T00:00:00Z', { availableSince })).toEqual(['not_yet_in_force']);
    expect(codesAt(d, '2026-09-12T00:00:00Z', { availableSince })).toEqual([]);
    expect(codesAt(d, '2026-09-10T00:00:00Z', { availableSince: at('2026-09-01T00:00:00Z') })).toEqual([]);
  });

  it('reports the in-force window it used', () => {
    const d = declaration({ 'valid-from': '2026-09-10T00:00:00Z', 'valid-until': '2026-12-01T00:00:00Z' });
    const result = checkLifecycle(d, { at: at('2026-09-15T00:00:00Z'), availableSince: at('2026-09-11T00:00:00Z') });
    expect(result.inForceFrom).toEqual(at('2026-09-11T00:00:00Z'));
    expect(result.inForceUntil).toEqual(at('2026-12-01T00:00:00Z'));
    expect(checkLifecycle(declaration(), { at: at('2026-09-15T00:00:00Z') }).inForceUntil).toBeUndefined();
  });
});

describe('checkLifecycle: revalidation (HCS §3.1.8)', () => {
  it('requires revalidation once the effective max-age has elapsed', () => {
    const d = declaration({ 'max-age': '7' });
    const validatedAt = at('2026-09-02T00:00:00Z');
    expect(codesAt(d, '2026-09-08T23:59:59.999Z', { validatedAt })).toEqual([]);
    expect(codesAt(d, '2026-09-09T00:00:00Z', { validatedAt })).toEqual(['revalidation_required']);
  });

  it('assumes the declaration was just validated when validatedAt is not given', () => {
    expect(codesAt(declaration(), '2027-09-15T00:00:00Z')).toEqual([]);
  });

  it('reports when revalidation is due', () => {
    const result = checkLifecycle(declaration({}, 'max-age="10"'), {
      at: at('2026-09-15T00:00:00Z'),
      validatedAt: at('2026-09-14T06:00:00Z'),
    });
    expect(result.revalidateBy).toEqual(at('2026-09-24T06:00:00Z'));
  });
});

describe('checkLifecycle: findings', () => {
  it('reports every failed rule with its section', () => {
    const d = declaration({ status: 'withdrawn', 'valid-until': '2026-09-10T00:00:00Z' });
    const result = checkLifecycle(d, { at: at('2026-09-20T00:00:00Z'), validatedAt: at('2026-08-01T00:00:00Z') });
    expect(result.reasons.map((r) => [r.code, r.rule])).toEqual([
      ['withdrawn', 'HCS §3.1.7.1'],
      ['expired', 'HCS §3.1.7.2'],
      ['revalidation_required', 'HCS §3.1.8'],
    ]);
  });
});
