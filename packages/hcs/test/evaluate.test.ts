import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  type EvaluationInput,
  type HcrnRecord,
  type RegistryAuthorization,
  type RegistryView,
  type RetrievedDocument,
  type Use,
} from '../src/evaluate';
import { HCS_NAMESPACE, RSL_NAMESPACE, parseHcsDocument } from '../src/parser';

const PERSONAS = new URL('../../../fixtures/personas/', import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, PERSONAS), 'utf8');

const GRANTMARK = 'https://registry.grantmark.example';
const HARBOR = 'https://registry.harbor-agency.example';
const AT = new Date('2026-10-01T12:00:00Z');

const HCSI = {
  mira: 'HCSI-0000-0034-T',
  tomas: 'HCSI-0000-0035-V',
  lina: 'HCSI-0000-0036-W',
  arden: 'HCSI-0000-0037-X',
  noor: 'HCSI-0000-0038-Y',
} as const;

/** An in-memory registry view; tests change its maps to break individual records. */
class MockRegistry implements RegistryView {
  readonly hcrns = new Map<string, HcrnRecord>();
  readonly hcsis = new Map<string, { hcsi: string; status: 'active' | 'inactive' }>();
  readonly subjects = new Map<string, unknown>();
  readonly authorizations = new Map<string, RegistryAuthorization>([
    [GRANTMARK, { registry: GRANTMARK, authorized: true }],
    [HARBOR, { registry: HARBOR, authorized: true }],
  ]);
  readonly members = new Map<string, Set<string>>();

  hcrnRecord(hcrn: string) {
    return this.hcrns.get(hcrn);
  }
  hcsiRecord(hcsi: string) {
    return this.hcsis.get(hcsi);
  }
  subjectRecord(hcsi: string) {
    return this.subjects.get(hcsi);
  }
  authorization(registry: string) {
    return this.authorizations.get(registry);
  }
  isMember(subjectClass: string, hcsi: string) {
    return this.members.get(subjectClass)?.has(hcsi);
  }

  /** Registers every declaration in a document at its official URL and returns the document. */
  publish(content: string): RetrievedDocument {
    const parsed = parseHcsDocument(content);
    if (!parsed.ok) throw new Error(parsed.error.message);
    let url = '';
    for (const right of parsed.document.rights) {
      const hcrn = right.attributes['registration-id']!;
      const registry = right.attributes.registry!;
      url = `${registry}/declarations/${hcrn}`;
      this.hcrns.set(hcrn, { hcrn, declarationUrl: url, registry });
    }
    return { url, content };
  }

  addSubject(hcsi: string, record: unknown) {
    this.hcsis.set(hcsi, { hcsi, status: 'active' });
    this.subjects.set(hcsi, record);
  }
}

function persona(name: keyof typeof HCSI, ...files: string[]) {
  const registry = new MockRegistry();
  const slug = { mira: 'mira-vale', tomas: 'tomas-reyka', lina: 'lina-sorel', arden: 'arden-holt', noor: 'noor-castell' }[name];
  registry.addSubject(HCSI[name], JSON.parse(fixture(`${slug}/subject.jsonld`)));
  const documents = (files.length > 0 ? files : ['declaration.xml']).map((f) => registry.publish(fixture(`${slug}/${f}`)));
  return { registry, documents, subject: HCSI[name] };
}

function run(setup: { registry: RegistryView; documents: readonly RetrievedDocument[]; subject: string }, use: Partial<Use> = {}, extra: Partial<EvaluationInput> = {}) {
  return evaluate({
    subject: setup.subject,
    documents: setup.documents,
    registry: setup.registry,
    use: { usage: 'hcs:ai-generate', at: AT, ...use },
    ...extra,
  });
}

const reasonCodes = (result: ReturnType<typeof run>) => result.declarations.flatMap((d) => d.reasons.map((r) => r.code));

describe('evaluate: persona scenarios', () => {
  it('mira-vale: generation is permitted with terms through two paid offers and a license server', () => {
    const result = run(persona('mira'), { scopes: ['image', 'likeness'] });
    expect(result.decision).toBe('permitted_with_terms');
    expect(result.declarations.map((d) => d.operative)).toEqual([true]);
    expect(result.scopes.map((s) => [s.scope, s.decision, s.governedBy])).toEqual([
      ['image', 'permitted_with_terms', ['HCRN-0000-0068-F']],
      ['likeness', 'permitted_with_terms', ['HCRN-0000-0068-F']],
    ]);
    expect(result.offers.map((o) => [o.hcrn, o.license, o.terms.payment?.amount?.value])).toEqual([
      ['HCRN-0000-0068-F', 1, '5.00'],
      ['HCRN-0000-0068-F', 2, '1.00'],
    ]);
    expect(result.offers[0]?.server).toBe('https://license.grantmark.example/olp');
    expect(result.offers[0]?.terms.source).toMatch(/^<license>[\s\S]*<\/license>$/);
    expect(result.serverAuthorizationRequired).toBe(true);
    expect(result.minorProtectionApplied).toBe(false);
    expect(result.ageStatus).toBe('adult');
  });

  it('mira-vale: training is prohibited', () => {
    const result = run(persona('mira'), { usage: 'hcs:ai-train', scopes: ['image'] });
    expect(result.decision).toBe('prohibited');
    expect(result.offers).toEqual([]);
  });

  it('mira-vale: scopes the declaration does not cover are not determinable', () => {
    expect(run(persona('mira'), { scopes: ['voice'] }).decision).toBe('not_determinable');
    const all = run(persona('mira'));
    expect(all.scopes.map((s) => s.scope)).toEqual(['name', 'image', 'likeness', 'voice', 'movement', 'signature']);
    expect(all.decision).toBe('not_determinable');
  });

  it('tomas-reyka: prohibited inside the territory, not determined outside it', () => {
    expect(run(persona('tomas'), { scopes: ['image'], place: 'DE' }).decision).toBe('prohibited');
    expect(run(persona('tomas'), { scopes: ['image'], place: 'US' }).decision).toBe('not_determinable');
  });

  it('tomas-reyka: an unknown place of use means the prohibition applies (§3.1.6.7)', () => {
    const result = run(persona('tomas'), { scopes: ['image'] });
    expect(result.decision).toBe('prohibited');
    expect(result.scopes[0]?.explanation).toMatch(/place of use/i);
  });

  it('lina-sorel: a minor gets no permission, payment or license server path (§1.1)', () => {
    const result = run(persona('lina'), { scopes: ['image'] });
    expect(result.ageStatus).toBe('minor');
    expect(result.minorProtectionApplied).toBe(true);
    expect(result.decision).toBe('not_determinable');
    expect(result.offers).toEqual([]);
    expect(result.serverAuthorizationRequired).toBe(false);
    expect(result.scopes[0]?.explanation).toMatch(/minor/i);
    // The declaration itself stays operative so that prohibitions could still be evaluated.
    expect(result.declarations[0]?.operative).toBe(true);
  });

  it('arden-holt: the overlapping scope is in conflict and prohibited; the rest is governed normally', () => {
    const setup = persona('arden', 'declaration-a.xml', 'declaration-b.xml');
    const image = run(setup, { scopes: ['image'] });
    expect(image.decision).toBe('permitted_with_terms');
    expect(image.scopes[0]?.governedBy).toEqual(['HCRN-0000-006B-J']);

    const likeness = run(setup, { scopes: ['likeness'] });
    expect(likeness.decision).toBe('prohibited');
    expect(likeness.scopes[0]?.conflict).toBe(true);
    expect(likeness.scopes[0]?.governedBy).toEqual(['HCRN-0000-006B-J', 'HCRN-0000-006C-K']);
    expect(likeness.scopes[0]?.explanation).toMatch(/conflict/i);

    const voice = run(setup, { scopes: ['voice'] });
    expect(voice.decision).toBe('prohibited');
    expect(voice.scopes[0]?.conflict).toBe(false);

    const both = run(setup, { scopes: ['image', 'likeness'] });
    expect(both.decision).toBe('prohibited');
    expect(both.offers).toEqual([]);
  });

  it('noor-castell: a withdrawn declaration is not operative, so nothing is permitted', () => {
    const result = run(persona('noor'), { scopes: ['image'] });
    expect(result.declarations[0]?.operative).toBe(false);
    expect(reasonCodes(result)).toEqual(['withdrawn']);
    expect(result.decision).toBe('not_determinable');
  });
});

describe('evaluate: registry records', () => {
  it('requires an HCRN lookup record (§4.2, §4.3.2)', () => {
    const setup = persona('mira');
    setup.registry.hcrns.clear();
    const result = run(setup, { scopes: ['image'] });
    expect(reasonCodes(result)).toEqual(['hcrn_not_assigned']);
    expect(result.decision).toBe('not_determinable');
  });

  it('requires the registry attribute to match the lookup record', () => {
    const setup = persona('mira');
    const record = setup.registry.hcrns.get('HCRN-0000-0068-F')!;
    setup.registry.hcrns.set(record.hcrn, { ...record, registry: 'https://registry.grantmark.example/' });
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toEqual(['registry_mismatch']);
  });

  it('relies only on the copy at the official URL', () => {
    const setup = persona('mira');
    const documents = [{ ...setup.documents[0]!, url: 'https://mirror.example/mira.xml' }];
    expect(reasonCodes(run({ ...setup, documents }, { scopes: ['image'] }))).toEqual(['not_official_copy']);
  });

  it('requires an authorized registry (§6.1)', () => {
    const setup = persona('mira');
    setup.registry.authorizations.set(GRANTMARK, { registry: GRANTMARK, authorized: false });
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toEqual(['registry_not_authorized']);
    setup.registry.authorizations.delete(GRANTMARK);
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toEqual(['registry_not_authorized']);
  });

  it('holds territorially limited registries to their countries (§6.1)', () => {
    const mira = persona('mira');
    mira.registry.authorizations.set(GRANTMARK, { registry: GRANTMARK, authorized: true, territory: ['US'] });
    expect(reasonCodes(run(mira, { scopes: ['image'] }))).toEqual(['registry_territory']);

    const tomas = persona('tomas');
    tomas.registry.authorizations.set(GRANTMARK, { registry: GRANTMARK, authorized: true, territory: ['DE'] });
    expect(reasonCodes(run(tomas, { scopes: ['image'], place: 'DE' }))).toEqual(['registry_territory']);
    tomas.registry.authorizations.set(GRANTMARK, { registry: GRANTMARK, authorized: true, territory: ['DE', 'FR', 'IT'] });
    expect(reasonCodes(run(tomas, { scopes: ['image'], place: 'DE' }))).toEqual([]);
  });

  it('requires an active HCSI and a Rights Subject Record (§3.2.3, §4.5)', () => {
    const inactive = persona('mira');
    inactive.registry.hcsis.set(HCSI.mira, { hcsi: HCSI.mira, status: 'inactive' });
    expect(reasonCodes(run(inactive, { scopes: ['image'] }))).toEqual(['hcsi_inactive']);

    const unassigned = persona('mira');
    unassigned.registry.hcsis.clear();
    expect(reasonCodes(run(unassigned, { scopes: ['image'] }))).toEqual(['hcsi_not_assigned']);

    const missing = persona('mira');
    missing.registry.subjects.clear();
    expect(reasonCodes(run(missing, { scopes: ['image'] }))).toEqual(['subject_record_missing']);
  });

  it('checks the Rights Subject Record and its match with <schema> (§3.2.1, §4.4.2)', () => {
    const setup = persona('mira');
    const record = setup.registry.subjects.get(HCSI.mira) as Record<string, unknown>;
    setup.registry.subjects.set(HCSI.mira, { ...record, identifier: [] });
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toEqual(['subject_record_invalid']);

    setup.registry.subjects.set(HCSI.mira, {
      ...record,
      '@type': 'Thing',
      additionalType: 'https://humanconsent.org/schemas/character',
      description: 'x',
    });
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toContain('subject_record_mismatch');
  });
});

describe('evaluate: minors policy (Grantmark decision, stricter than HCS §1.1)', () => {
  it('requires evidence of adulthood by default', () => {
    const setup = persona('mira');
    const record = setup.registry.subjects.get(HCSI.mira) as Record<string, unknown>;
    const { birthDate: _removed, ...withoutBirthDate } = record;
    setup.registry.subjects.set(HCSI.mira, withoutBirthDate);

    const strict = run(setup, { scopes: ['image'] });
    expect(strict.ageStatus).toBe('unknown');
    expect(strict.minorProtectionApplied).toBe(true);
    expect(strict.decision).toBe('not_determinable');
    expect(strict.scopes[0]?.explanation).toMatch(/adulthood/i);

    const lenient = run(setup, { scopes: ['image'] }, { minorPolicy: 'known_minor_only' });
    expect(lenient.minorProtectionApplied).toBe(false);
    expect(lenient.decision).toBe('permitted_with_terms');
  });

  it('refuses known minors under either policy', () => {
    const result = run(persona('lina'), { scopes: ['image'] }, { minorPolicy: 'known_minor_only' });
    expect(result.minorProtectionApplied).toBe(true);
    expect(result.offers).toEqual([]);
  });

  it('still evaluates prohibitions for minors', () => {
    const setup = persona('lina');
    const content = fixture('lina-sorel/declaration.xml').replace(
      /<permits type="usage">hcs:ai-generate<\/permits>\s*<payment type="purchase">\s*<amount currency="USD">3.00<\/amount>\s*<\/payment>/,
      '<prohibits type="usage">hcs:ai-generate</prohibits>',
    );
    const result = run({ ...setup, documents: [setup.registry.publish(content)] }, { scopes: ['image'] });
    expect(result.decision).toBe('prohibited');
    expect(result.minorProtectionApplied).toBe(true);
  });

  it('does not apply to subjects other than identity', () => {
    const registry = new MockRegistry();
    registry.addSubject('HCSI-0000-0039-Z', { name: 'no birthDate needed' });
    const result = run(
      { registry, subject: 'HCSI-0000-0039-Z', documents: [registry.publish(characterDeclaration)] },
      { scopes: ['visual'] },
    );
    // The mock record is not a valid Character object, but the minors rule must not be involved.
    expect(result.minorProtectionApplied).toBe(false);
    expect(result.ageStatus).toBeUndefined();
  });
});

const RSL_OPEN = `<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}">`;
const LEGAL = '<legal type="attestation">true</legal><legal type="contact">https://registry.grantmark.example/c</legal>';

const characterDeclaration =
  RSL_OPEN +
  `<hcs:right registry="${GRANTMARK}" registration-id="HCRN-0000-006E-N" issued="2026-09-01T00:00:00Z" ` +
  'subject="character" subject-id="HCSI-0000-0039-Z"><schema type="application/ld+json">' +
  JSON.stringify({
    '@context': 'https://schema.org',
    '@id': 'https://id.humanconsent.org/HCSI-0000-0039-Z',
    '@type': 'Thing',
    additionalType: 'https://humanconsent.org/schemas/character',
    name: 'Fictional Character',
    description: 'A fictional character used in Grantmark tests.',
    identifier: [{ '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://personas.grantmark.example/c' }],
  }) +
  `</schema><license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license></hcs:right></rsl>`;

/** A declaration for mira-vale's HCSI with custom attributes and license. */
function miraDeclaration(hcrn: string, attributes: string, license: string, registry = GRANTMARK) {
  const schema = fixture('mira-vale/declaration.xml').match(/<schema[\s\S]*?<\/schema>/)![0];
  return (
    RSL_OPEN +
    `<hcs:right registry="${registry}" registration-id="${hcrn}" issued="2026-09-01T00:00:00Z" subject="identity" ` +
    `subject-id="${HCSI.mira}" ${attributes}>${schema}${license}</hcs:right></rsl>`
  );
}

describe('evaluate: offers and decisions', () => {
  const setupWith = (...contents: string[]) => {
    const registry = new MockRegistry();
    registry.addSubject(HCSI.mira, JSON.parse(fixture('mira-vale/subject.jsonld')));
    return { registry, subject: HCSI.mira, documents: contents.map((c) => registry.publish(c)) };
  };

  it('is "permitted" when a free, unconditional offer exists and no license server is named', () => {
    const setup = setupWith(miraDeclaration('HCRN-0000-006F-P', '', `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`));
    const result = run(setup, { scopes: ['image'] });
    expect(result.decision).toBe('permitted');
    expect(result.serverAuthorizationRequired).toBe(false);
  });

  it('treats a license server, payment, user limits or reporting as terms', () => {
    const base = (attributes: string, extra: string) =>
      run(setupWith(miraDeclaration('HCRN-0000-006F-P', attributes, `<license><permits type="usage">hcs:ai-generate</permits>${extra}${LEGAL}</license>`)), {
        scopes: ['image'],
      }).decision;
    expect(base('server="https://license.grantmark.example/olp"', '')).toBe('permitted_with_terms');
    expect(base('', '<payment type="attribution"/>')).toBe('permitted_with_terms');
    expect(base('', '<payment><custom>https://clear.example</custom></payment>')).toBe('permitted_with_terms');
    expect(base('', '<permits type="user">non-commercial</permits>')).toBe('permitted_with_terms');
    expect(base('', '<reporting type="audit" profile="https://example.com/p"/>')).toBe('permitted_with_terms');
    expect(base('', '<payment type="free"/>')).toBe('permitted');
  });

  it('grants nothing from a license without <permits type="usage">', () => {
    const setup = setupWith(
      miraDeclaration('HCRN-0000-006F-P', '', `<license><payment type="purchase"><amount currency="USD">1</amount></payment>${LEGAL}</license>`),
    );
    expect(run(setup, { scopes: ['image'] }).decision).toBe('not_determinable');
  });

  it('applies license geo terms, expanding EU, and needs a known place for them', () => {
    const license = `<license><permits type="usage">hcs:ai-generate</permits><permits type="geo">EU</permits><prohibits type="geo">DE</prohibits>${LEGAL}</license>`;
    const setup = setupWith(miraDeclaration('HCRN-0000-006F-P', '', license));
    expect(run(setup, { scopes: ['image'], place: 'FR' }).decision).toBe('permitted_with_terms');
    expect(run(setup, { scopes: ['image'], place: 'DE' }).decision).toBe('not_determinable');
    expect(run(setup, { scopes: ['image'], place: 'US' }).decision).toBe('not_determinable');
    expect(run(setup, { scopes: ['image'] }).decision).toBe('not_determinable');
  });

  it('lets a prohibition in any license win over permissions (RSL §3.1.1)', () => {
    const licenses =
      `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>` +
      `<license><prohibits type="usage">hcs:ai-generate</prohibits>${LEGAL}</license>`;
    expect(run(setupWith(miraDeclaration('HCRN-0000-006F-P', '', licenses)), { scopes: ['image'] }).decision).toBe('prohibited');
  });

  it('does not rely on territory-dependent permissions when the place is unknown', () => {
    const setup = setupWith(miraDeclaration('HCRN-0000-006F-P', 'territory="US"', `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`));
    expect(run(setup, { scopes: ['image'], place: 'US' }).decision).toBe('permitted');
    expect(run(setup, { scopes: ['image'] }).decision).toBe('not_determinable');
  });

  it('does not see a conflict between declarations whose territories do not overlap', () => {
    const permit = `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`;
    const prohibit = `<license><prohibits type="usage">hcs:ai-generate</prohibits>${LEGAL}</license>`;
    const setup = setupWith(
      miraDeclaration('HCRN-0000-006F-P', 'territory="US"', permit),
      miraDeclaration('HCRN-0000-006G-Q', 'territory="DE"', prohibit, HARBOR),
    );
    expect(run(setup, { scopes: ['image'], place: 'US' }).decision).toBe('permitted');
    expect(run(setup, { scopes: ['image'], place: 'DE' }).decision).toBe('prohibited');
    const unknown = run(setup, { scopes: ['image'] });
    expect(unknown.decision).toBe('prohibited');
    expect(unknown.scopes[0]?.conflict).toBe(false);
  });

  it('sees a conflict even when the terms are identical', () => {
    const permit = `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license>`;
    const setup = setupWith(miraDeclaration('HCRN-0000-006F-P', '', permit), miraDeclaration('HCRN-0000-006G-Q', '', permit, HARBOR));
    const result = run(setup, { scopes: ['image'] });
    expect(result.decision).toBe('prohibited');
    expect(result.scopes[0]?.conflict).toBe(true);
  });

  it('ignores declarations about other subjects in the same document', () => {
    const other = miraDeclaration('HCRN-0000-006F-P', '', `<license><prohibits type="usage">hcs:ai-generate</prohibits>${LEGAL}</license>`).replace(
      `subject-id="${HCSI.mira}"`,
      `subject-id="${HCSI.tomas}"`,
    );
    const setup = persona('mira');
    const result = run({ ...setup, documents: [...setup.documents, setup.registry.publish(other)] }, { scopes: ['image'] });
    expect(result.declarations).toHaveLength(1);
    expect(result.decision).toBe('permitted_with_terms');
  });

  it('reports documents that cannot be parsed and conformance failures', () => {
    const setup = persona('mira');
    const broken = { url: 'https://registry.grantmark.example/declarations/broken', content: '<rsl>' };
    const bad = miraDeclaration('HCRN-0000-006F-P', '', '<license><permits type="usage">hcs:ai-generate</permits></license>');
    const result = run({ ...setup, documents: [broken, setup.registry.publish(bad)] }, { scopes: ['image'] });
    expect(result.declarations.map((d) => [d.operative, d.reasons.map((r) => r.code)])).toEqual([
      [false, ['parse_error']],
      [false, ['legal_attestation', 'legal_contact']],
    ]);
    expect(result.decision).toBe('not_determinable');
  });

  it('applies lifecycle rules using the validation time and the registry publication time', () => {
    const setup = persona('mira');
    const stale = run({ ...setup, documents: [{ ...setup.documents[0]!, validatedAt: new Date('2026-09-01T00:00:00Z') }] }, { scopes: ['image'] });
    expect(reasonCodes(stale)).toEqual(['revalidation_required']);
    expect(stale.declarations[0]?.revalidateBy).toEqual(new Date('2026-09-08T00:00:00Z'));

    const record = setup.registry.hcrns.get('HCRN-0000-0068-F')!;
    setup.registry.hcrns.set(record.hcrn, { ...record, availableSince: new Date('2026-10-05T00:00:00Z') });
    expect(reasonCodes(run(setup, { scopes: ['image'] }))).toEqual(['not_yet_in_force']);
  });

  it('does not rely on component declarations in the MVP', () => {
    const setup = setupWith(
      miraDeclaration('HCRN-0000-006F-P', '', `<license><permits type="usage">hcs:ai-generate</permits>${LEGAL}</license><hcs:included registration-id="HCRN-0000-0001-1"/>`),
    );
    const result = run(setup, { scopes: ['image'] });
    expect(reasonCodes(result)).toEqual(['component_unsupported']);
    expect(result.decision).toBe('not_determinable');
  });
});

describe('evaluate: Default Declarations (§3.1.5, §3.1.9.3)', () => {
  const CLASS = 'https://registry.grantmark.example/classes/members';
  const collection = JSON.stringify({
    '@context': 'https://schema.org',
    '@id': CLASS,
    '@type': 'Collection',
    additionalType: 'https://humanconsent.org/schemas/identity',
    name: 'Fictional members',
    description: 'Fictional members covered by a Grantmark test default declaration.',
  });
  const defaultDeclaration = (hcrn: string, scope: string, usage: 'permits' | 'prohibits', subjectClass = CLASS) =>
    RSL_OPEN +
    `<hcs:right registry="${GRANTMARK}" registration-id="${hcrn}" issued="2026-09-01T00:00:00Z" subject="identity" ` +
    `subject-scope="${scope}" subject-class="${subjectClass}"><schema type="application/ld+json">${collection.replace(CLASS, subjectClass)}</schema>` +
    `<license><${usage} type="usage">hcs:ai-generate</${usage}>${LEGAL}</license></hcs:right></rsl>`;

  const setup = (member: boolean, ...contents: string[]) => {
    const registry = new MockRegistry();
    registry.addSubject(HCSI.mira, JSON.parse(fixture('mira-vale/subject.jsonld')));
    if (member) {
      registry.members.set(CLASS, new Set([HCSI.mira]));
      registry.members.set(`${CLASS}-2`, new Set([HCSI.mira]));
    }
    return { registry, subject: HCSI.mira, documents: contents.map((c) => registry.publish(c)) };
  };

  it('applies only when membership is established', () => {
    const prohibit = defaultDeclaration('HCRN-0000-006H-R', 'voice', 'prohibits');
    expect(run(setup(true, prohibit), { scopes: ['voice'] }).decision).toBe('prohibited');
    const outsider = run(setup(false, prohibit), { scopes: ['voice'] });
    expect(outsider.decision).toBe('not_determinable');
    expect(outsider.declarations[0]?.member).toBe(false);
  });

  it('gives way to a specific declaration in the overlapping scope only', () => {
    const prohibit = defaultDeclaration('HCRN-0000-006H-R', 'image voice', 'prohibits');
    const s = setup(true, prohibit);
    s.documents = [...s.documents, s.registry.publish(fixture('mira-vale/declaration.xml'))];
    const image = run(s, { scopes: ['image'] });
    expect(image.decision).toBe('permitted_with_terms');
    expect(image.scopes[0]?.governedBy).toEqual(['HCRN-0000-0068-F']);
    expect(run(s, { scopes: ['voice'] }).decision).toBe('prohibited');
  });

  it('puts two applicable Default Declarations in conflict', () => {
    const s = setup(
      true,
      defaultDeclaration('HCRN-0000-006H-R', 'voice', 'permits'),
      defaultDeclaration('HCRN-0000-006J-S', 'voice', 'permits', `${CLASS}-2`),
    );
    const result = run(s, { scopes: ['voice'] });
    expect(result.decision).toBe('prohibited');
    expect(result.scopes[0]?.conflict).toBe(true);
  });
});
