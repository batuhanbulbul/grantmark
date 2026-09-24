import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HCS_NAMESPACE, RSL_NAMESPACE, parseHcsDocument, type HcsDocument } from '../src/parser';

const PERSONAS = new URL('../../../fixtures/personas/', import.meta.url);
const fixtureText = (path: string) => readFileSync(new URL(path, PERSONAS), 'utf8');
const fixtureBytes = (path: string) => new Uint8Array(readFileSync(new URL(path, PERSONAS)));

const NS = `xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"`;

function parse(input: string | Uint8Array): HcsDocument {
  const result = parseHcsDocument(input);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.document;
}

function errorCode(input: string) {
  const result = parseHcsDocument(input);
  return result.ok ? 'ok' : result.error.code;
}

/** A minimal <hcs:right> body; the attributes are not validated by the parser. */
const right = (attributes: string, body = '') => `<hcs:right ${attributes}>${body}</hcs:right>`;

describe('parseHcsDocument: document level', () => {
  it('exports the RSL and HCS namespace URIs', () => {
    expect(RSL_NAMESPACE).toBe('https://rslstandard.org/rsl');
    expect(HCS_NAMESPACE).toBe('https://humanconsent.org/hcs');
  });

  it.each([
    ['a root with another name', `<license xmlns="${RSL_NAMESPACE}"/>`],
    ['an <rsl> root without a namespace', '<rsl/>'],
    ['an <rsl> root in another namespace', '<rsl xmlns="https://example.com/rsl"/>'],
  ])('rejects %s as not_rsl', (_label, input) => {
    expect(errorCode(input)).toBe('not_rsl');
  });

  it('passes XML reader errors through', () => {
    expect(errorCode(`<!DOCTYPE rsl><rsl ${NS}/>`)).toBe('doctype');
    expect(errorCode(`<rsl ${NS}>`)).toBe('malformed');
  });

  it('records whether the root declares the HCS namespace, under any prefix', () => {
    expect(parse(`<rsl ${NS}/>`).declaresHcsNamespace).toBe(true);
    expect(
      parse(`<rsl xmlns="${RSL_NAMESPACE}" xmlns:h="${HCS_NAMESPACE}"/>`).declaresHcsNamespace,
    ).toBe(true);
    const nested = parse(
      `<rsl xmlns="${RSL_NAMESPACE}"><hcs:right xmlns:hcs="${HCS_NAMESPACE}"/></rsl>`,
    );
    expect(nested.declaresHcsNamespace).toBe(false);
    expect(nested.rights).toHaveLength(1);
  });

  it('keeps root attributes, separating namespaced ones', () => {
    const doc = parse(
      `<rsl ${NS} xmlns:ext="https://ext.example" max-age="10" ext:note="n"/>`,
    );
    expect(doc.attributes).toEqual({ 'max-age': '10' });
    expect(doc.foreignAttributes.map((a) => [a.local, a.uri, a.value])).toEqual([
      ['note', 'https://ext.example', 'n'],
    ]);
  });

  it('sorts root children into rights, RSL content, extensions and unexpected elements', () => {
    const doc = parse(
      `<rsl ${NS} xmlns:ext="https://ext.example">` +
        `<content url="https://example.com/a"/>` +
        `<ext:meta><hcs:right registration-id="nested"/></ext:meta>` +
        `<plain xmlns=""/>` +
        right('registration-id="HCRN-0000-0000-0"') +
        `<license/>` +
        `<hcs:sitemap/>` +
        `</rsl>`,
    );
    expect(doc.rights.map((r) => r.attributes['registration-id'])).toEqual(['HCRN-0000-0000-0']);
    expect(doc.content.map((e) => e.local)).toEqual(['content']);
    expect(doc.extensions.map((e) => [e.local, e.uri])).toEqual([
      ['meta', 'https://ext.example'],
      ['plain', ''],
    ]);
    expect(doc.unexpected.map((e) => e.name)).toEqual(['license', 'hcs:sitemap']);
  });

  it('returns an empty list when the document has no <hcs:right>', () => {
    expect(parse(`<rsl ${NS}><content url=""/></rsl>`).rights).toEqual([]);
  });
});

describe('parseHcsDocument: <hcs:right>', () => {
  it('keeps unprefixed attributes as written and separates namespaced ones', () => {
    const doc = parse(
      `<rsl ${NS} xmlns:ext="https://ext.example">` +
        right('registry="https://r.example" subject="identity" unknown="x" ext:flag="1"') +
        `</rsl>`,
    );
    const [r] = doc.rights;
    expect(r?.attributes).toEqual({
      registry: 'https://r.example',
      subject: 'identity',
      unknown: 'x',
    });
    expect(r?.foreignAttributes.map((a) => a.name)).toEqual(['ext:flag']);
  });

  it('sorts children by role', () => {
    const body =
      `<schema type="application/ld+json">{}</schema>` +
      `<license/><license/>` +
      `<terms>https://example.com/terms</terms>` +
      `<hcs:certification name="N" contact="mailto:a@example.com" time="2026-01-01T00:00:00Z" jws="x"/>` +
      `<hcs:includes registration-id="HCRN-0000-0001-1"><schema>https://example.com/s</schema></hcs:includes>` +
      `<hcs:included registration-id="HCRN-0000-0002-2"/>` +
      `<ext:note xmlns:ext="https://ext.example">n</ext:note>` +
      `<copyright>c</copyright>` +
      `<hcs:unknown/>`;
    const [r] = parse(`<rsl ${NS}>${right('', body)}</rsl>`).rights;
    expect(r?.schemas.map((s) => [s.attributes.type, s.text])).toEqual([
      ['application/ld+json', '{}'],
    ]);
    expect(r?.licenses).toHaveLength(2);
    expect(r?.terms.map((t) => t.text)).toEqual(['https://example.com/terms']);
    expect(r?.certifications[0]?.attributes).toEqual({
      name: 'N',
      contact: 'mailto:a@example.com',
      time: '2026-01-01T00:00:00Z',
      jws: 'x',
    });
    expect(r?.includes[0]?.attributes['registration-id']).toBe('HCRN-0000-0001-1');
    expect(r?.includes[0]?.schemas.map((s) => s.text)).toEqual(['https://example.com/s']);
    expect(r?.included[0]?.attributes['registration-id']).toBe('HCRN-0000-0002-2');
    expect(r?.included[0]?.schemas).toEqual([]);
    expect(r?.extensions.map((e) => e.local)).toEqual(['note']);
    expect(r?.unexpected.map((e) => e.name)).toEqual(['copyright', 'hcs:unknown']);
  });

  it('reads CDATA and escaped JSON in <schema> alike', () => {
    const doc = parse(
      `<rsl ${NS}>` +
        right('', '<schema type="application/ld+json"><![CDATA[{"a":"<b> & c"}]]></schema>') +
        right('', '<schema type="application/ld+json">{"a":"&lt;b&gt; &amp; c"}</schema>') +
        `</rsl>`,
    );
    const values = doc.rights.map((r) => JSON.parse(r.schemas[0]!.text));
    expect(values).toEqual([{ a: '<b> & c' }, { a: '<b> & c' }]);
  });

  it('keeps text placed directly inside the element', () => {
    const [r] = parse(`<rsl ${NS}>${right('', ' stray <license/> text ')}</rsl>`).rights;
    expect(r?.text.trim()).toBe('stray  text');
  });

  it('keeps the exact source text of each declaration', () => {
    const first = '<hcs:right\r\n   registration-id="HCRN-0000-0000-0"\tissued="x" >😀\n</hcs:right>';
    const second = '<hcs:right registration-id="HCRN-0000-0001-1"/>';
    const source = `<rsl ${NS}>\n  ${first}\n  <!-- é -->${second}\n</rsl>`;
    const doc = parse(source);
    expect(doc.rights.map((r) => r.source)).toEqual([first, second]);
    expect(doc.source).toBe(source);
  });
});

describe('parseHcsDocument: <license>', () => {
  const license =
    `<license xmlns:ext="https://ext.example">` +
    `<permits type="usage">hcs:ai-generate</permits>` +
    `<permits type="user">commercial</permits>` +
    `<prohibits type="usage">hcs:ai-train</prohibits>` +
    `<payment type="purchase">` +
    `<standard>https://example.com/std</standard>` +
    `<custom>https://example.com/clear</custom>` +
    `<amount currency="USD">5.00</amount>` +
    `<accepts type="application/x402+json">x</accepts>` +
    `<ext:rate>r</ext:rate>` +
    `<legal type="contact">misplaced</legal>` +
    `</payment>` +
    `<reporting type="audit" profile="https://example.com/p" endpoint="https://example.com/e"/>` +
    `<legal type="attestation"> true </legal>` +
    `<legal type="contact">mailto:rights@example.com</legal>` +
    `<legal type="warranty">ownership</legal>` +
    `<ext:note>n</ext:note>` +
    `<content url=""/>` +
    `</license>`;

  const [lic] = parse(`<rsl ${NS}>${right('', license)}</rsl>`).rights[0]!.licenses;

  it('reads permits and prohibits with their type and raw token text', () => {
    expect(lic?.permits.map((p) => [p.attributes.type, p.text])).toEqual([
      ['usage', 'hcs:ai-generate'],
      ['user', 'commercial'],
    ]);
    expect(lic?.prohibits.map((p) => [p.attributes.type, p.text])).toEqual([
      ['usage', 'hcs:ai-train'],
    ]);
  });

  it('reads payment and its children', () => {
    const [payment] = lic!.payments;
    expect(payment?.attributes).toEqual({ type: 'purchase' });
    expect(payment?.standard.map((e) => e.text)).toEqual(['https://example.com/std']);
    expect(payment?.custom.map((e) => e.text)).toEqual(['https://example.com/clear']);
    expect(payment?.amounts.map((e) => [e.attributes.currency, e.text])).toEqual([['USD', '5.00']]);
    expect(payment?.accepts.map((e) => [e.attributes.type, e.text])).toEqual([
      ['application/x402+json', 'x'],
    ]);
    expect(payment?.extensions.map((e) => e.local)).toEqual(['rate']);
    expect(payment?.unexpected.map((e) => e.local)).toEqual(['legal']);
  });

  it('reads reporting and legal elements without normalizing their text', () => {
    expect(lic?.reporting.map((r) => r.attributes)).toEqual([
      { type: 'audit', profile: 'https://example.com/p', endpoint: 'https://example.com/e' },
    ]);
    expect(lic?.legal.map((l) => [l.attributes.type, l.text])).toEqual([
      ['attestation', ' true '],
      ['contact', 'mailto:rights@example.com'],
      ['warranty', 'ownership'],
    ]);
  });

  it('separates extensions from unexpected RSL elements', () => {
    expect(lic?.extensions.map((e) => e.local)).toEqual(['note']);
    expect(lic?.unexpected.map((e) => e.local)).toEqual(['content']);
  });

  it('reports child elements of leaf elements as unexpected or extensions', () => {
    const [l] = parse(
      `<rsl ${NS}>` +
        right(
          '',
          `<license><legal type="contact"><terms>x</terms><ext:x xmlns:ext="https://ext.example"/></legal></license>`,
        ) +
        `</rsl>`,
    ).rights[0]!.licenses;
    expect(l?.legal[0]?.unexpected.map((e) => e.local)).toEqual(['terms']);
    expect(l?.legal[0]?.extensions.map((e) => e.local)).toEqual(['x']);
  });
});

describe('parseHcsDocument: persona fixture', () => {
  const text = fixtureText('mira-vale/declaration.xml');

  it('reads the main demo declaration', () => {
    const doc = parse(text);
    expect(doc.declaresHcsNamespace).toBe(true);
    expect(doc.rights).toHaveLength(1);
    const [r] = doc.rights;
    expect(r?.attributes).toEqual({
      registry: 'https://registry.grantmark.example',
      'registration-id': 'HCRN-0000-0068-F',
      issued: '2026-09-01T00:00:00Z',
      subject: 'identity',
      'subject-scope': 'image likeness',
      'subject-id': 'HCSI-0000-0034-T',
      'max-age': '7',
      server: 'https://license.grantmark.example/olp',
    });
    expect(JSON.parse(r!.schemas[0]!.text).name).toBe('Mira Vale');
    expect(r?.licenses.map((l) => l.payments[0]?.amounts[0]?.text)).toEqual(['5.00', '1.00']);
  });

  it('gives the exact bytes of the declaration for byte input', () => {
    const bytes = fixtureBytes('mira-vale/declaration.xml');
    const [r] = parse(bytes).rights;
    const start = text.indexOf('<hcs:right');
    const end = text.indexOf('</hcs:right>') + '</hcs:right>'.length;
    const expected = new TextEncoder().encode(text.slice(start, end));
    expect(new TextEncoder().encode(r!.source)).toEqual(expected);
    expect(Buffer.from(bytes).includes(Buffer.from(expected))).toBe(true);
  });
});
