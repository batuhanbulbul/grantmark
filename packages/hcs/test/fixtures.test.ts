import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDocument } from '../src/conformance';
import { isReservedTestId, isValidHcsId } from '../src/ids';
import { checkLifecycle } from '../src/lifecycle';
import { checkRightsSubjectObject } from '../src/profiles';
import { parseHcsDocument, type HcsRight } from '../src/parser';

const PERSONAS = new URL('../../../fixtures/personas/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, PERSONAS), 'utf8');

const CANONICAL_ID_BASE = 'https://id.humanconsent.org/';

// A fixed date for the age checks: the adult personas are adults and the minor is still a minor.
const DEMO_DATE = '2026-10-12';

function declaration(path: string): HcsRight {
  const result = parseHcsDocument(read(path));
  if (!result.ok) throw new Error(`${path}: ${result.error.code}: ${result.error.message}`);
  expect(result.document.rights).toHaveLength(1);
  return result.document.rights[0]!;
}

function subjectRecord(persona: string): Record<string, unknown> {
  return JSON.parse(read(`${persona}/subject.jsonld`));
}

function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

const tokens = (value: string | undefined) => (value ?? '').trim().split(/\s+/);

const personas = readdirSync(PERSONAS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const declarationFiles = personas.flatMap((persona) =>
  readdirSync(new URL(`${persona}/`, PERSONAS))
    .filter((file) => file.endsWith('.xml'))
    .map((file) => `${persona}/${file}`),
);

describe('persona fixtures: shared rules', () => {
  it('has the five planned personas', () => {
    expect(personas).toEqual(['arden-holt', 'lina-sorel', 'mira-vale', 'noor-castell', 'tomas-reyka']);
  });

  it('uses only valid identifiers from the HCS reserved test range', () => {
    for (const persona of personas) {
      for (const file of readdirSync(new URL(`${persona}/`, PERSONAS))) {
        const ids = read(`${persona}/${file}`).match(/HC(?:RN|SI)-[^\s"<]+/g) ?? [];
        expect(ids.length, `${persona}/${file}`).toBeGreaterThan(0);
        for (const id of ids) {
          expect(isValidHcsId(id), id).toBe(true);
          expect(isReservedTestId(id), id).toBe(true);
        }
      }
    }
  });

  it.each(declarationFiles)('%s is labelled as fictional and matches its subject record', (path) => {
    const persona = path.split('/')[0]!;
    const right = declaration(path);
    const schema = JSON.parse(right.schemas[0]!.text);
    const record = subjectRecord(persona);

    expect(read(path)).toMatch(/Fictional test data for Grantmark/);
    expect(schema.description).toMatch(/^Fictional /);
    expect(record.description).toBe(schema.description);

    const canonicalId = CANONICAL_ID_BASE + right.attributes['subject-id'];
    expect(schema['@id']).toBe(canonicalId);
    expect(record['@id']).toBe(canonicalId);
    expect(record.name).toBe(schema.name);
    expect(record['@type']).toBe('Person');
    expect(record.additionalType).toBe('https://humanconsent.org/schemas/identity');
  });

  it.each(declarationFiles)('%s conforms to the HCS 1.0 Draft', (path) => {
    const parsed = parseHcsDocument(read(path));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const [result] = checkDocument(parsed.document);
    expect(result?.reasons).toEqual([]);
    expect(result?.warnings).toEqual([]);
  });

  it.each(personas)('%s has a subject record that conforms to the Identity profile', (persona) => {
    const record = subjectRecord(persona);
    const hcsi = String(record['@id']).slice(CANONICAL_ID_BASE.length);
    expect(checkRightsSubjectObject(record, { subject: 'identity', subjectId: hcsi })).toEqual([]);
  });

  it('gives every declaration a unique HCRN', () => {
    const hcrns = declarationFiles.map((path) => declaration(path).attributes['registration-id']);
    expect(new Set(hcrns).size).toBe(hcrns.length);
  });

  it('gives every persona its own HCSI', () => {
    const hcsis = personas.map((persona) => subjectRecord(persona)['@id']);
    expect(new Set(hcsis).size).toBe(personas.length);
  });
});

describe('persona fixtures: roles', () => {
  it('mira-vale: adult, permits hcs:ai-generate for payment, with a license server', () => {
    const right = declaration('mira-vale/declaration.xml');
    expect(ageOn(String(subjectRecord('mira-vale').birthDate), DEMO_DATE)).toBeGreaterThanOrEqual(18);
    expect(right.attributes.server).toMatch(/^https:\/\//);
    expect(right.licenses).toHaveLength(2);
    for (const license of right.licenses) {
      expect(license.permits.find((p) => p.attributes.type === 'usage')?.text).toBe('hcs:ai-generate');
      expect(license.payments[0]?.amounts[0]?.attributes.currency).toBe('USD');
    }
  });

  it('tomas-reyka: adult, prohibits both usage tokens, limited to a territory', () => {
    const right = declaration('tomas-reyka/declaration.xml');
    expect(ageOn(String(subjectRecord('tomas-reyka').birthDate), DEMO_DATE)).toBeGreaterThanOrEqual(18);
    expect(right.attributes.territory).toBe('DE FR');
    const [license] = right.licenses;
    expect(license?.permits).toEqual([]);
    expect(tokens(license?.prohibits[0]?.text)).toEqual(['hcs:ai-generate', 'hcs:ai-train']);
  });

  it('lina-sorel: a minor whose declaration tries to permit paid use', () => {
    const right = declaration('lina-sorel/declaration.xml');
    expect(ageOn(String(subjectRecord('lina-sorel').birthDate), DEMO_DATE)).toBeLessThan(18);
    const [license] = right.licenses;
    expect(license?.permits[0]?.text).toBe('hcs:ai-generate');
    expect(license?.payments).toHaveLength(1);
    expect(right.attributes.server).toBeDefined();
  });

  it('arden-holt: two declarations from different registries that overlap on one scope', () => {
    const a = declaration('arden-holt/declaration-a.xml');
    const b = declaration('arden-holt/declaration-b.xml');
    expect(ageOn(String(subjectRecord('arden-holt').birthDate), DEMO_DATE)).toBeGreaterThanOrEqual(18);
    expect(a.attributes['subject-id']).toBe(b.attributes['subject-id']);
    expect(a.attributes.registry).not.toBe(b.attributes.registry);
    const overlap = tokens(a.attributes['subject-scope']).filter((s) =>
      tokens(b.attributes['subject-scope']).includes(s),
    );
    expect(overlap).toEqual(['likeness']);
    expect(a.licenses[0]?.permits[0]?.text).toBe('hcs:ai-generate');
    expect(tokens(b.licenses[0]?.prohibits[0]?.text)).toContain('hcs:ai-generate');
  });

  it('noor-castell: adult, a paid permission that has been withdrawn', () => {
    const right = declaration('noor-castell/declaration.xml');
    expect(ageOn(String(subjectRecord('noor-castell').birthDate), DEMO_DATE)).toBeGreaterThanOrEqual(18);
    expect(right.attributes.status).toBe('withdrawn');
    expect(right.licenses[0]?.permits[0]?.text).toBe('hcs:ai-generate');

    const parsed = parseHcsDocument(read('noor-castell/declaration.xml'));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const normalized = checkDocument(parsed.document)[0]!.declaration!;
    const lifecycle = checkLifecycle(normalized, { at: new Date(`${DEMO_DATE}T12:00:00Z`) });
    expect(lifecycle.reasons.map((r) => r.code)).toEqual(['withdrawn']);
  });
});
