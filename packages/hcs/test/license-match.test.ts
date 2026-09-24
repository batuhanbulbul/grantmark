import { describe, expect, it } from 'vitest';
import { canonicalElement, canonicalLicense } from '../src/license-match';
import { HCS_NAMESPACE, RSL_NAMESPACE, parseHcsDocument } from '../src/parser';

const OFFER =
  '<license>\n' +
  '  <permits type="usage">hcs:ai-generate</permits>\n' +
  '  <payment type="purchase"><amount currency="USD">5.00</amount></payment>\n' +
  '  <legal type="attestation">true</legal>\n' +
  '  <legal type="contact">https://registry.example/contact</legal>\n' +
  '</license>';

const same = (a: string, b: string) => {
  const ca = canonicalLicense(a);
  const cb = canonicalLicense(b);
  return ca !== undefined && ca === cb;
};

describe('canonicalLicense', () => {
  it('reads a <license> fragment without a namespace declaration as RSL', () => {
    expect(canonicalLicense(OFFER)).toBeDefined();
    expect(same(OFFER, OFFER.replace('<license>', `<license xmlns="${RSL_NAMESPACE}">`))).toBe(true);
  });

  it('ignores whitespace, attribute order and child order', () => {
    const reordered =
      '<license><legal type="contact"> https://registry.example/contact </legal>' +
      '<payment type="purchase"><amount currency="USD">5.00</amount></payment>' +
      '<legal type="attestation">true</legal><permits type="usage">hcs:ai-generate</permits></license>';
    expect(same(OFFER, reordered)).toBe(true);
  });

  it('ignores the order of list tokens in permits and prohibits', () => {
    expect(
      same(
        '<license><prohibits type="usage">hcs:ai-generate hcs:ai-train</prohibits></license>',
        '<license><prohibits type="usage">hcs:ai-train  hcs:ai-generate</prohibits></license>',
      ),
    ).toBe(true);
  });

  it('compares namespaces, not prefixes', () => {
    const prefixed = `<r:license xmlns:r="${RSL_NAMESPACE}"><r:permits type="usage">hcs:ai-generate</r:permits></r:license>`;
    expect(same('<license><permits type="usage">hcs:ai-generate</permits></license>', prefixed)).toBe(true);
  });

  it.each([
    ['a different price', OFFER.replace('5.00', '1.00')],
    ['a different currency', OFFER.replace('USD', 'EUR')],
    ['a missing element', OFFER.replace('<legal type="attestation">true</legal>', '')],
    ['an extra element', OFFER.replace('</license>', '<permits type="user">commercial</permits></license>')],
    ['a different usage', OFFER.replace('hcs:ai-generate', 'hcs:ai-train')],
    ['another namespace', OFFER.replace('<license>', '<license xmlns="https://example.com/other">')],
  ])('tells apart %s', (_label, other) => {
    expect(same(OFFER, other)).toBe(false);
  });

  it.each([
    ['text that is not XML', 'license'],
    ['two elements', `${OFFER}${OFFER}`],
    ['an element other than <license>', '<payment/>'],
    ['a DOCTYPE', `<!DOCTYPE license>${OFFER}`],
    ['an entity reference', '<license>&xxe;</license>'],
    ['an empty string', ''],
  ])('returns undefined for %s', (_label, input) => {
    expect(canonicalLicense(input)).toBeUndefined();
  });
});

describe('canonicalElement', () => {
  it('matches a license inside a parsed declaration with its standalone form', () => {
    const xml = `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"><hcs:right>${OFFER}</hcs:right></rsl>`;
    const parsed = parseHcsDocument(xml);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const element = parsed.document.rights[0]!.licenses[0]!.element;
    expect(canonicalElement(element)).toBe(canonicalLicense(OFFER));
  });
});
