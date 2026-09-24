import { describe, expect, it } from 'vitest';
import { checkDocument, type DeclarationCheck } from '../src/conformance';
import { HCS_NAMESPACE, RSL_NAMESPACE, parseHcsDocument } from '../src/parser';

const HCRN = 'HCRN-0000-0068-F';
const HCSI = 'HCSI-0000-0034-T';

const PERSON = {
  '@context': 'https://schema.org',
  '@id': `https://id.humanconsent.org/${HCSI}`,
  '@type': 'Person',
  additionalType: 'https://humanconsent.org/schemas/identity',
  name: 'Test Person',
  identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://example.com/p' }],
};

const SCHEMA = `<schema type="application/ld+json">${JSON.stringify(PERSON)}</schema>`;
const LEGAL =
  '<legal type="attestation">true</legal><legal type="contact">https://registry.example/contact</legal>';
const LICENSE = `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`;

const BASE_ATTRIBUTES: Record<string, string> = {
  registry: 'https://registry.example',
  'registration-id': HCRN,
  issued: '2026-01-01T00:00:00Z',
  subject: 'identity',
  'subject-id': HCSI,
};

interface Options {
  attributes?: Record<string, string | undefined>;
  body?: string;
  extra?: string; // raw text appended inside the start tag
}

function right({ attributes = {}, body = SCHEMA + LICENSE, extra = '' }: Options = {}) {
  const merged = { ...BASE_ATTRIBUTES, ...attributes };
  const text = Object.entries(merged)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');
  return `<hcs:right ${text}${extra}>${body}</hcs:right>`;
}

const doc = (content: string, rootExtra = '') =>
  `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}"${rootExtra}>${content}</rsl>`;

function checks(xml: string): readonly DeclarationCheck[] {
  const parsed = parseHcsDocument(xml);
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  return checkDocument(parsed.document);
}

const check = (options: Options = {}) => checks(doc(right(options)))[0]!;
const codes = (options: Options = {}) => check(options).reasons.map((r) => r.code);
const withLicense = (license: string) => codes({ body: SCHEMA + license });
const withLegal = (legal: string) =>
  withLicense(`<license><permits type="usage">hcs:ai-generate</permits>${legal}</license>`);

describe('checkDocument: a conforming declaration', () => {
  it('has no reasons or warnings and yields a normalized declaration', () => {
    const result = check({
      attributes: { 'subject-scope': ' likeness  image likeness ', territory: 'US GB', 'max-age': '7' },
    });
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.declaration).toMatchObject({
      registry: 'https://registry.example',
      registrationId: HCRN,
      issued: { text: '2026-01-01T00:00:00Z', time: Date.UTC(2026, 0, 1) },
      subject: 'identity',
      subjectScope: ['likeness', 'image'],
      territory: ['US', 'GB'],
      subjectId: HCSI,
      status: 'active',
      supersedes: [],
      supersededBy: [],
      maxAge: 7,
      profile: 'https://humanconsent.org/schemas/identity',
      includes: [],
    });
    expect(result.declaration?.schema).toEqual(PERSON);
    expect(result.declaration?.subjectClass).toBeUndefined();
    expect(result.declaration?.documentMaxAge).toBeUndefined();
  });

  it('collapses whitespace in token-typed attribute values', () => {
    const result = check({ attributes: { subject: ' identity ', 'registration-id': ` ${HCRN}\n` } });
    expect(result.reasons).toEqual([]);
    expect(result.declaration?.registrationId).toBe(HCRN);
  });

  it('normalizes each license', () => {
    const license =
      '<license>' +
      '<permits type="usage">hcs:ai-generate hcs:ai-generate</permits>' +
      '<permits type="user">commercial ext:partner</permits>' +
      '<prohibits type="usage">hcs:ai-train</prohibits>' +
      '<prohibits type="geo">EU CN</prohibits>' +
      '<payment type="purchase"><amount currency="USD"> 5.00 </amount>' +
      '<accepts type="application/x402+json">x402</accepts></payment>' +
      '<reporting type="audit" profile="https://example.com/audit"/>' +
      '<legal type="attestation"> true </legal>' +
      '<legal type="contact">mailto:rights@example.com</legal>' +
      '<legal type="warranty">ownership authority</legal>' +
      '</license>';
    const result = check({ body: SCHEMA + license });
    expect(result.reasons).toEqual([]);
    expect(result.declaration?.licenses).toEqual([
      {
        permits: { usage: ['hcs:ai-generate'], user: ['commercial', 'ext:partner'] },
        prohibits: { usage: ['hcs:ai-train'], geo: ['EU', 'CN'] },
        payment: {
          type: 'purchase',
          amount: { currency: 'USD', value: '5.00' },
          accepts: { type: 'application/x402+json', value: 'x402' },
        },
        reporting: [{ type: 'audit', profile: 'https://example.com/audit' }],
        contact: 'mailto:rights@example.com',
        warranty: ['ownership', 'authority'],
        source: license,
      },
    ]);
  });

  it('keeps the root max-age and the exact source', () => {
    const xml = doc(right(), ' max-age="10"');
    const [result] = checks(xml);
    expect(result?.declaration?.documentMaxAge).toBe(10);
    expect(result?.declaration?.source).toBe(right());
  });

  it('accepts a Default Declaration with a Collection schema', () => {
    const collection = {
      '@context': 'https://schema.org',
      '@id': 'https://guild.example/members',
      '@type': 'Collection',
      additionalType: 'https://humanconsent.org/schemas/identity',
      name: 'Members',
      description: 'Fictional members.',
    };
    const result = check({
      attributes: { 'subject-id': undefined, 'subject-class': 'https://guild.example/members' },
      body: `<schema type="application/ld+json">${JSON.stringify(collection)}</schema>${LICENSE}`,
    });
    expect(result.reasons).toEqual([]);
    expect(result.declaration?.subjectClass).toBe('https://guild.example/members');
  });

  it('allows extension elements and extension attributes on the root', () => {
    const xml = doc(
      right({ body: `${SCHEMA}<ext:note xmlns:ext="https://ext.example">n</ext:note>${LICENSE}` }) +
        '<content url="https://example.com/a"/><ext:x/>',
      ' xmlns:ext="https://ext.example" ext:flag="1"',
    );
    expect(checks(xml)[0]?.reasons).toEqual([]);
  });
});

describe('checkDocument: document-level rules', () => {
  it('fails every declaration when the root does not declare the HCS namespace (§2.2)', () => {
    const xml =
      `<rsl xmlns="${RSL_NAMESPACE}">` +
      right().replace('<hcs:right', `<hcs:right xmlns:hcs="${HCS_NAMESPACE}"`) +
      '</rsl>';
    expect(checks(xml)[0]?.reasons.map((r) => r.code)).toEqual(['hcs_namespace_not_on_root']);
  });

  it.each([
    ['an unknown unprefixed attribute', ' version="1"'],
    ['an attribute in the RSL namespace', ` xmlns:r="${RSL_NAMESPACE}" r:x="1"`],
    ['an attribute in the HCS namespace', ' hcs:x="1"'],
    ['an invalid max-age', ' max-age="0"'],
  ])('rejects %s on the root', (_label, rootExtra) => {
    expect(checks(doc(right(), rootExtra))[0]?.reasons.map((r) => r.code)).toEqual([
      'invalid_root_attribute',
    ]);
  });

  it('rejects RSL or HCS elements that have no place at the root', () => {
    const xml = doc(right() + '<license/>');
    expect(checks(xml)[0]?.reasons.map((r) => r.code)).toEqual(['unexpected_root_element']);
  });

  it('fails every declaration that shares an HCRN with another in the document (§3.1.2)', () => {
    const other = right({ attributes: { 'registration-id': 'HCRN-0000-0069-G' } });
    const results = checks(doc(right() + other + right()));
    expect(results.map((r) => r.reasons.map((x) => x.code))).toEqual([
      ['duplicate_registration_id'],
      [],
      ['duplicate_registration_id'],
    ]);
    expect(results[0]?.declaration).toBeUndefined();
  });
});

describe('checkDocument: <hcs:right> attributes (§3.1)', () => {
  it.each(['registry', 'registration-id', 'issued', 'subject'])('requires %s', (name) => {
    const result = check({ attributes: { [name]: undefined } });
    expect(result.reasons.map((r) => [r.code, r.at])).toEqual([['missing_attribute', `@${name}`]]);
  });

  it('rejects unknown and namespaced attributes (Appendix A)', () => {
    expect(codes({ attributes: { color: 'blue' } })).toEqual(['unknown_attribute']);
    expect(codes({ extra: ' hcs:registry="https://registry.example"' })).toEqual(['foreign_attribute']);
  });

  it.each([
    ['registry', 'http://registry.example'],
    ['registry', 'registry.example'],
    ['registration-id', 'HCRN-0000-0068-G'],
    ['registration-id', HCSI],
    ['registration-id', 'hcrn-0000-0068-f'],
    ['issued', '2026-01-01t00:00:00Z'],
    ['issued', '2026-01-01'],
    ['subject', 'person'],
    ['territory', 'us'],
    ['territory', 'USA'],
    ['territory', ' '],
    ['territory', 'XK'],
    ['territory', 'US ZZ'],
    ['subject-id', 'HCSI-0000-0034-V'],
    ['status', 'revoked'],
    ['supersedes', `HCRN-0000-0001-1 ${HCSI}`],
    ['valid-from', '2026-02-30T00:00:00Z'],
    ['valid-until', 'soon'],
    ['max-age', '0'],
    ['max-age', '1.5'],
    ['server', 'http://license.example'],
  ])('rejects %s="%s"', (name, value) => {
    expect(codes({ attributes: { [name]: value } })).toEqual(['invalid_attribute_value']);
  });

  it('requires exactly one of subject-id and subject-class', () => {
    expect(codes({ attributes: { 'subject-id': undefined } })).toEqual(['subject_identification']);
    expect(codes({ attributes: { 'subject-class': 'https://guild.example/members' } })).toContain(
      'subject_identification',
    );
  });

  it('rejects a subject-class that is not an HTTPS URL', () => {
    const result = codes({
      attributes: { 'subject-id': undefined, 'subject-class': 'http://guild.example/members' },
    });
    expect(result).toContain('invalid_attribute_value');
  });

  it('requires superseded-by when status is superseded', () => {
    const result = check({ attributes: { status: 'superseded' } });
    expect(result.reasons.map((r) => [r.code, r.at])).toEqual([
      ['missing_attribute', '@superseded-by'],
    ]);
    const complete = check({ attributes: { status: 'superseded', 'superseded-by': 'HCRN-0000-0069-G' } });
    expect(complete.reasons).toEqual([]);
    expect(complete.declaration?.status).toBe('superseded');
    expect(complete.declaration?.supersededBy).toEqual(['HCRN-0000-0069-G']);
  });

  describe('subject-scope (§3.1.6.2)', () => {
    it.each([
      ['identity', 'image voice'],
      ['work', 'composition recording'],
      ['character', 'visual persona'],
    ])('accepts values defined for %s', (subject, scope) => {
      // The schema is an Identity object, so other categories also fail the profile check.
      const result = check({ attributes: { subject, 'subject-scope': scope } });
      expect(result.reasons.filter((r) => r.code === 'invalid_subject_scope')).toEqual([]);
    });

    it.each([
      ['an undefined value', 'identity', 'image face'],
      ['a value from another category', 'identity', 'visual'],
      ['an empty list', 'identity', ' '],
      ['any value with subject="mark"', 'mark', 'name'],
    ])('rejects %s', (_label, subject, scope) => {
      expect(codes({ attributes: { subject, 'subject-scope': scope } })).toContain(
        'invalid_subject_scope',
      );
    });
  });
});

describe('checkDocument: <hcs:right> children', () => {
  it('requires exactly one <schema> and at least one <license> (§3.1)', () => {
    expect(codes({ body: LICENSE })).toEqual(['element_count']);
    expect(codes({ body: SCHEMA + SCHEMA + LICENSE })).toEqual(['element_count']);
    expect(codes({ body: SCHEMA })).toEqual(['element_count']);
  });

  it('allows at most one <terms>', () => {
    const terms = '<terms>https://example.com/terms</terms>';
    expect(check({ body: SCHEMA + terms + LICENSE }).declaration?.terms).toBe('https://example.com/terms');
    expect(codes({ body: SCHEMA + terms + terms + LICENSE })).toEqual(['element_count']);
  });

  it('rejects misplaced RSL/HCS elements and stray text', () => {
    expect(codes({ body: SCHEMA + LICENSE + '<copyright>c</copyright>' })).toEqual(['unexpected_element']);
    expect(codes({ body: SCHEMA + LICENSE + '<hcs:note/>' })).toEqual(['unexpected_element']);
    expect(codes({ body: SCHEMA + 'stray' + LICENSE })).toEqual(['unexpected_text']);
  });

  describe('component references (§3.4)', () => {
    const includes = (id: string) => `<hcs:includes registration-id="${id}"/>`;
    const included = (id: string) => `<hcs:included registration-id="${id}"/>`;

    it('reads includes and included', () => {
      const title = check({ body: SCHEMA + LICENSE + includes('HCRN-0000-0001-1') + includes('HCRN-0000-0002-2') });
      expect(title.reasons).toEqual([]);
      expect(title.declaration?.includes).toEqual(['HCRN-0000-0001-1', 'HCRN-0000-0002-2']);
      const component = check({ body: SCHEMA + LICENSE + included('HCRN-0000-0001-1') });
      expect(component.declaration?.included).toBe('HCRN-0000-0001-1');
    });

    it('rejects includes together with included, or two included', () => {
      expect(codes({ body: SCHEMA + LICENSE + includes('HCRN-0000-0001-1') + included('HCRN-0000-0002-2') })).toEqual([
        'component_reference',
      ]);
      expect(codes({ body: SCHEMA + LICENSE + included('HCRN-0000-0001-1') + included('HCRN-0000-0002-2') })).toEqual([
        'element_count',
      ]);
    });

    it('rejects component references in a Default Declaration', () => {
      const collection = JSON.stringify({
        '@context': 'https://schema.org',
        '@id': 'https://guild.example/members',
        '@type': 'Collection',
        additionalType: 'https://humanconsent.org/schemas/identity',
        name: 'Members',
        description: 'Fictional members.',
      });
      const result = codes({
        attributes: { 'subject-id': undefined, 'subject-class': 'https://guild.example/members' },
        body: `<schema type="application/ld+json">${collection}</schema>${LICENSE}${included('HCRN-0000-0001-1')}`,
      });
      expect(result).toEqual(['component_reference']);
    });

    it('checks the reference element itself', () => {
      expect(codes({ body: SCHEMA + LICENSE + includes('HCRN-0000-0001-2') })).toEqual(['invalid_attribute_value']);
      expect(codes({ body: SCHEMA + LICENSE + '<hcs:included/>' })).toEqual(['missing_attribute']);
      expect(codes({ body: SCHEMA + LICENSE + '<hcs:included registration-id="HCRN-0000-0001-1" note="x"/>' })).toEqual([
        'unknown_attribute',
      ]);
    });
  });

  describe('certification (§3.3): problems are warnings, never reasons', () => {
    const certification = (attributes: string) => `<hcs:certification ${attributes}/>`;
    const valid = 'name="Firm" contact="https://firm.example" role="law-firm" time="2026-01-02T00:00:00Z" jws="a.b.c"';

    it('accepts a structurally valid certification', () => {
      const result = check({ body: SCHEMA + LICENSE + certification(valid) });
      expect(result.reasons).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it.each([
      ['a missing jws', 'name="Firm" contact="https://firm.example" time="2026-01-02T00:00:00Z"'],
      ['an invalid role', valid.replace('law-firm', 'Law--Firm')],
      ['a non-URL contact', valid.replace('https://firm.example', 'firm@example.com')],
      ['a time before issued', valid.replace('2026-01-02', '2025-12-31')],
    ])('warns about %s', (_label, attributes) => {
      const result = check({ body: SCHEMA + LICENSE + certification(attributes) });
      expect(result.reasons).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toEqual(['certification_invalid']);
    });

    it('warns about more than one certification', () => {
      const result = check({ body: SCHEMA + LICENSE + certification(valid) + certification(valid) });
      expect(result.reasons).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toEqual(['certification_invalid']);
    });
  });
});

describe('checkDocument: <schema> (§3.2)', () => {
  it.each([
    ['a missing type attribute', `<schema>${JSON.stringify(PERSON)}</schema>`, 'missing_attribute'],
    ['another type', `<schema type="application/json">${JSON.stringify(PERSON)}</schema>`, 'invalid_attribute_value'],
    ['text that is not JSON', '<schema type="application/ld+json">{nope</schema>', 'schema_invalid'],
    ['an empty body', '<schema type="application/ld+json"></schema>', 'schema_invalid'],
    ['a child element', `<schema type="application/ld+json">${JSON.stringify(PERSON)}<x xmlns="urn:x"/></schema>`, 'unexpected_element'],
  ])('rejects %s', (_label, schema, code) => {
    expect(codes({ body: schema + LICENSE })).toEqual([code]);
  });

  it('rejects an object that breaks the profile rules', () => {
    const schema = `<schema type="application/ld+json">${JSON.stringify({ ...PERSON, '@id': 'https://example.com/me' })}</schema>`;
    const result = check({ body: schema + LICENSE });
    expect(result.reasons.map((r) => [r.code, r.at])).toEqual([['schema_invalid', 'schema/@id']]);
  });

  it('requires the profile category to match subject', () => {
    expect(codes({ attributes: { subject: 'character' } })).toContain('schema_invalid');
  });
});

describe('checkDocument: <license>', () => {
  it('rejects attributes on <license>', () => {
    expect(withLicense(`<license id="1"><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`)).toEqual([
      'unknown_attribute',
    ]);
  });

  it('points at the failing license', () => {
    const bad = '<license><permits type="usage">hcs:ai-generate</permits></license>';
    const result = check({ body: SCHEMA + LICENSE + bad });
    expect(result.reasons.map((r) => r.at)).toEqual(['license[2]', 'license[2]']);
  });

  describe('usage tokens (§3)', () => {
    it.each([
      ['an RSL token', 'ai-train'],
      ['an unknown hcs token', 'hcs:ai-edit'],
      ['a token in the wrong case', 'HCS:AI-GENERATE'],
    ])('rejects %s', (_label, token) => {
      expect(withLicense(`<license><permits type="usage">${token}</permits>${LEGAL}</license>`)).toEqual([
        'unrecognized_usage_token',
      ]);
      expect(withLicense(`<license><prohibits type="usage">hcs:ai-generate ${token}</prohibits>${LEGAL}</license>`)).toEqual([
        'unrecognized_usage_token',
      ]);
    });
  });

  it.each([
    ['a missing type', '<permits>hcs:ai-generate</permits>', 'missing_attribute'],
    ['an unknown type', '<permits type="time">x</permits>', 'invalid_attribute_value'],
    ['an empty token list', '<permits type="usage"> </permits>', 'invalid_element_value'],
    ['an unknown user token', '<permits type="user">business</permits>', 'invalid_element_value'],
    ['a malformed geo token', '<prohibits type="geo">usa</prohibits>', 'invalid_element_value'],
    ['a geo code that is not officially assigned', '<permits type="geo">XK</permits>', 'invalid_element_value'],
    ['two permits of one type', '<permits type="usage">hcs:ai-generate</permits><permits type="usage">hcs:ai-train</permits>', 'element_count'],
    ['two prohibits of one type', '<prohibits type="user">personal</prohibits><prohibits type="user">education</prohibits>', 'element_count'],
    ['an extra attribute', '<permits type="usage" scope="x">hcs:ai-generate</permits>', 'unknown_attribute'],
  ])('rejects permits/prohibits with %s', (_label, element, code) => {
    expect(withLicense(`<license>${element}${LEGAL}</license>`)).toEqual([code]);
  });

  it.each([
    ['two payment elements', '<payment/><payment/>', 'element_count'],
    ['an unknown payment type', '<payment type="royalty"/>', 'invalid_attribute_value'],
    ['a lowercase currency', '<payment><amount currency="usd">5</amount></payment>', 'invalid_attribute_value'],
    ['a currency with spaces', '<payment><amount currency=" USD">5</amount></payment>', 'invalid_attribute_value'],
    ['a non-decimal amount', '<payment><amount currency="USD">five</amount></payment>', 'invalid_element_value'],
    ['two amounts', '<payment><amount currency="USD">5</amount><amount currency="EUR">5</amount></payment>', 'element_count'],
    ['a relative standard URL', '<payment><standard>/std</standard></payment>', 'invalid_element_value'],
    ['an empty custom URL', '<payment><custom> </custom></payment>', 'invalid_element_value'],
    ['accepts without type', '<payment><accepts>x</accepts></payment>', 'missing_attribute'],
    ['a misplaced RSL element', '<payment><legal type="proof">https://example.com</legal></payment>', 'unexpected_element'],
  ])('rejects payment with %s', (_label, payment, code) => {
    expect(withLicense(`<license><permits type="usage">hcs:ai-generate</permits>${payment}${LEGAL}</license>`)).toEqual([
      code,
    ]);
  });

  it('accepts an extension payment type and extension elements in payment', () => {
    const license =
      '<license xmlns:ext="https://ext.example"><permits type="usage">hcs:ai-generate</permits>' +
      `<payment type="ext:escrow"><ext:rate/></payment>${LEGAL}</license>`;
    expect(withLicense(license)).toEqual([]);
  });

  it.each([
    ['a missing profile', '<reporting type="audit"/>', 'missing_attribute'],
    ['an unknown type', '<reporting type="billing" profile="https://example.com/p"/>', 'invalid_attribute_value'],
    ['a non-HTTPS endpoint', '<reporting type="audit" profile="https://example.com/p" endpoint="http://example.com/e"/>', 'invalid_attribute_value'],
  ])('rejects reporting with %s', (_label, reporting, code) => {
    expect(withLicense(`<license><permits type="usage">hcs:ai-generate</permits>${reporting}${LEGAL}</license>`)).toEqual([
      code,
    ]);
  });

  describe('required legal elements (§6.4)', () => {
    const contact = '<legal type="contact">https://registry.example/contact</legal>';
    const attestation = '<legal type="attestation">true</legal>';

    it.each([
      ['missing', ''],
      ['not the lowercase token true', '<legal type="attestation">True</legal>'],
      ['false', '<legal type="attestation">false</legal>'],
      ['repeated', attestation + attestation],
    ])('fails when the attestation is %s', (_label, legal) => {
      expect(withLegal(legal + contact)).toEqual(['legal_attestation']);
    });

    it.each([
      ['missing', ''],
      ['a bare email address', '<legal type="contact">rights@example.com</legal>'],
      ['an http URL', '<legal type="contact">http://registry.example/contact</legal>'],
      ['two URLs in one element', '<legal type="contact">https://a.example https://b.example</legal>'],
      ['repeated', contact + contact],
    ])('fails when the contact is %s', (_label, legal) => {
      expect(withLegal(attestation + legal)).toEqual(['legal_contact']);
    });

    it('accepts a mailto contact and whitespace around both values', () => {
      expect(withLegal('<legal type="attestation">\n true \n</legal><legal type="contact"> mailto:a@example.com </legal>')).toEqual([]);
    });

    it.each([
      ['an unknown legal type', '<legal type="notice">x</legal>', 'invalid_attribute_value'],
      ['an unknown warranty token', '<legal type="warranty">quality</legal>', 'invalid_element_value'],
      ['an unknown disclaimer token', '<legal type="disclaimer">as-was</legal>', 'invalid_element_value'],
      ['a relative proof URI', '<legal type="proof">/proof</legal>', 'invalid_element_value'],
      ['two warranties', '<legal type="warranty">ownership</legal><legal type="warranty">authority</legal>', 'element_count'],
    ])('rejects %s', (_label, legal, code) => {
      expect(withLegal(attestation + contact + legal)).toEqual([code]);
    });
  });
});

describe('checkDocument: findings', () => {
  it('names the rule and the location', () => {
    const [reason] = check({ attributes: { registry: 'http://registry.example' } }).reasons;
    expect(reason).toMatchObject({ code: 'invalid_attribute_value', rule: 'HCS §3.1.1', at: '@registry' });
    expect(reason?.message).toMatch(/registry/);
  });

  it('reports every failed rule, not just the first', () => {
    const result = check({ attributes: { registry: undefined, subject: 'person' }, body: SCHEMA });
    expect(result.reasons.map((r) => r.code).sort()).toEqual([
      'element_count',
      'invalid_attribute_value',
      'missing_attribute',
    ]);
    expect(result.declaration).toBeUndefined();
  });
});
