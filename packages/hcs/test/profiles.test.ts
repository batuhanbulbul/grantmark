import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_URL_SOURCES,
  IDENTIFIER_VALUE_SYSTEMS,
  SCHEMA_PROFILES,
  checkDefaultDeclarationObject,
  checkRightsSubjectObject,
  profileById,
} from '../src/profiles';

const HCSI = 'HCSI-0000-0034-T';
const CANONICAL = `https://id.humanconsent.org/${HCSI}`;

function person(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@id': CANONICAL,
    '@type': 'Person',
    additionalType: 'https://humanconsent.org/schemas/identity',
    name: 'Test Person',
    identifier: [
      { '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://example.com/p' },
    ],
    ...overrides,
  };
}

const identity = (value: unknown) =>
  checkRightsSubjectObject(value, { subject: 'identity', subjectId: HCSI }).map((p) => p.message);

describe('profile registry (HCS Schema Profiles 1.0 Draft)', () => {
  it('lists all 17 profiles with unique identifiers', () => {
    expect(SCHEMA_PROFILES).toHaveLength(17);
    expect(new Set(SCHEMA_PROFILES.map((p) => p.id)).size).toBe(17);
    for (const profile of SCHEMA_PROFILES) {
      expect(profile.id).toMatch(/^https:\/\/humanconsent\.org\/schemas\/[a-z]+$/);
    }
  });

  it('assigns each profile to one subject category', () => {
    const count = (subject: string) => SCHEMA_PROFILES.filter((p) => p.subject === subject).length;
    expect([count('work'), count('identity'), count('character'), count('mark')]).toEqual([
      11, 1, 1, 4,
    ]);
  });

  it('only references identifier systems and URL sources defined in §2.3', () => {
    const known = new Set([...IDENTIFIER_VALUE_SYSTEMS, ...IDENTIFIER_URL_SOURCES]);
    for (const profile of SCHEMA_PROFILES) {
      for (const id of [...profile.normative, ...profile.additional]) {
        expect(known.has(id), `${profile.id}: ${id}`).toBe(true);
      }
    }
  });

  it('describes the Identity profile as published', () => {
    expect(profileById('https://humanconsent.org/schemas/identity')).toMatchObject({
      subject: 'identity',
      types: ['Person'],
      additional: ['Wikipedia'],
    });
    expect(profileById('https://humanconsent.org/schemas/identity')?.normative).toContain('IPN');
    expect(profileById('https://humanconsent.org/schemas/unknown')).toBeUndefined();
  });
});

describe('checkRightsSubjectObject (HCS §3.2.1, Schema Profiles §2)', () => {
  it('accepts a conforming Identity object', () => {
    expect(identity(person())).toEqual([]);
  });

  it('accepts extra Schema.org properties and nested @type', () => {
    const value = person({
      birthDate: '1990-01-01',
      alternateName: ['T. Person'],
      worksFor: { '@type': 'Organization', name: 'Example Org' },
    });
    expect(identity(value)).toEqual([]);
  });

  it.each([
    ['a JSON array', []],
    ['a string', 'x'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(identity(value)).toHaveLength(1);
  });

  it.each([
    ['wrong @context', { '@context': 'http://schema.org' }],
    ['@context as an array', { '@context': ['https://schema.org'] }],
    ['@id that is not the canonical HCSI URI', { '@id': 'https://id.humanconsent.org/HCSI-0000-0035-V' }],
    ['@type not permitted by the profile', { '@type': 'Organization' }],
    ['@type as an array', { '@type': ['Person'] }],
    ['unknown profile', { additionalType: 'https://humanconsent.org/schemas/unknown' }],
    ['profile of another subject category', { additionalType: 'https://humanconsent.org/schemas/character', '@type': 'Person', description: 'x' }],
    ['missing name', { name: undefined }],
    ['name as an array', { name: ['a', 'b'] }],
    ['empty identifier array', { identifier: [] }],
    ['identifier not an array', { identifier: { '@type': 'PropertyValue', propertyID: 'OfficialPage', url: 'https://example.com' } }],
    ['alternateName with a number', { alternateName: ['a', 1] }],
    ['other JSON-LD keyword', { '@graph': [] }],
    ['JSON-LD keyword in a nested object', { worksFor: { '@id': 'x', '@language': 'en' } }],
    ['deathDate that is not a date', { deathDate: 'last year' }],
  ])('rejects %s', (_label, overrides) => {
    expect(identity(person(overrides))).not.toEqual([]);
  });

  describe('identifiers (§2.2)', () => {
    const withIds = (...ids: unknown[]) => identity(person({ identifier: ids }));
    const url = (propertyID: string, value = 'https://example.com/x') => ({
      '@type': 'PropertyValue',
      propertyID,
      url: value,
    });
    const val = (propertyID: string, value = 'X') => ({ '@type': 'PropertyValue', propertyID, value });

    it('accepts value and URL forms from the profile', () => {
      expect(withIds(val('ISNI'), url('IMDb'), url('Wikipedia'))).toEqual([]);
    });

    it('requires at least one Normative Identifier', () => {
      expect(withIds(url('Wikipedia'))).not.toEqual([]);
    });

    it('rejects identifiers the profile does not support', () => {
      expect(withIds(url('OfficialPage'), val('ISBN'))).not.toEqual([]);
    });

    it('rejects unknown propertyID values, compared case-sensitively', () => {
      expect(withIds(url('OfficialPage'), url('officialpage'))).not.toEqual([]);
    });

    it('rejects the wrong form for a system', () => {
      expect(withIds(url('ISNI'))).not.toEqual([]);
      expect(withIds(val('OfficialPage'))).not.toEqual([]);
    });

    it('rejects an entry with both value and url', () => {
      expect(withIds({ ...url('OfficialPage'), value: 'X' })).not.toEqual([]);
    });

    it('rejects a non-HTTPS identifier URL', () => {
      expect(withIds(url('OfficialPage', 'http://example.com/x'))).not.toEqual([]);
    });

    it('rejects an entry without @type PropertyValue', () => {
      expect(withIds({ propertyID: 'OfficialPage', url: 'https://example.com/x' })).not.toEqual([]);
    });
  });

  describe('profile-specific properties', () => {
    const photo = (overrides: Record<string, unknown>) =>
      checkRightsSubjectObject(
        {
          '@context': 'https://schema.org',
          '@id': CANONICAL,
          '@type': 'Photograph',
          additionalType: 'https://humanconsent.org/schemas/photo',
          name: 'A photo',
          identifier: [{ '@type': 'PropertyValue', propertyID: 'ISCC', value: 'X' }],
          ...overrides,
        },
        { subject: 'work', subjectId: HCSI },
      );

    it('requires image where the profile does, in any permitted form', () => {
      expect(photo({})).not.toEqual([]);
      expect(photo({ image: 'https://example.com/a.jpg' })).toEqual([]);
      expect(photo({ image: { '@type': 'ImageObject', contentUrl: 'https://example.com/a.jpg' } })).toEqual([]);
      expect(photo({ image: ['https://example.com/a.jpg', { '@type': 'ImageObject', contentUrl: 'https://example.com/b.jpg' }] })).toEqual([]);
    });

    it('rejects image values that are not HTTPS or lack contentUrl', () => {
      expect(photo({ image: 'http://example.com/a.jpg' })).not.toEqual([]);
      expect(photo({ image: { '@type': 'ImageObject', url: 'https://example.com/a.jpg' } })).not.toEqual([]);
      expect(photo({ image: [] })).not.toEqual([]);
    });

    it('requires description for characters', () => {
      const character = (overrides: Record<string, unknown>) =>
        checkRightsSubjectObject(
          {
            '@context': 'https://schema.org',
            '@id': CANONICAL,
            '@type': 'Thing',
            additionalType: 'https://humanconsent.org/schemas/character',
            name: 'A character',
            identifier: [{ '@type': 'PropertyValue', propertyID: 'Wikidata', url: 'https://www.wikidata.org/entity/Q1' }],
            ...overrides,
          },
          { subject: 'character', subjectId: HCSI },
        );
      expect(character({})).not.toEqual([]);
      expect(character({ description: 'A detective in a fictional series.' })).toEqual([]);
    });
  });

  it('reports each problem with the rule it breaks', () => {
    const [problem] = checkRightsSubjectObject(person({ '@context': 'x' }), {
      subject: 'identity',
      subjectId: HCSI,
    });
    expect(problem?.rule).toMatch(/Schema Profiles §2\.1/);
    expect(problem?.at).toBe('@context');
  });
});

describe('checkDefaultDeclarationObject (HCS §3.2.2)', () => {
  const CLASS = 'https://guild.grantmark.example/members';
  const collection = (overrides: Record<string, unknown> = {}) => ({
    '@context': 'https://schema.org',
    '@id': CLASS,
    '@type': 'Collection',
    additionalType: 'https://humanconsent.org/schemas/identity',
    name: 'Members',
    description: 'Fictional members covered by this default declaration.',
    ...overrides,
  });
  const check = (value: unknown) =>
    checkDefaultDeclarationObject(value, { subject: 'identity', subjectClass: CLASS });

  it('accepts a conforming Collection, with extra properties', () => {
    expect(check(collection())).toEqual([]);
    expect(check(collection({ publisher: { '@type': 'Organization', name: 'Guild' } }))).toEqual([]);
  });

  it.each([
    ['@id different from subject-class', { '@id': 'https://guild.grantmark.example/other' }],
    ['@type other than Collection', { '@type': 'Person' }],
    ['profile of another subject category', { additionalType: 'https://humanconsent.org/schemas/movie' }],
    ['missing description', { description: undefined }],
    ['name that is not a string', { name: 1 }],
  ])('rejects %s', (_label, overrides) => {
    expect(check(collection(overrides))).not.toEqual([]);
  });
});
