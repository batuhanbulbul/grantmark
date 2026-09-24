/**
 * HCS Schema Profile Registry 1.0 Draft (2026-08-08), https://humanconsent.org/schemas.
 *
 * All profiles are still `Draft`; the HCS 1.0 Draft lets Draft profiles satisfy its
 * finalized-profile requirement. Objects are checked as parsed JSON, before JSON-LD expansion
 * (HCS §3.2). Rules that need the Rights Subject Record are applied by the evaluator.
 */

import { isHttpsUrl } from './lexical';
import { CANONICAL_ID_BASE, type SubjectCategory } from './vocabulary';

/** Identifier Systems: used with the Identifier Value form (§2.3.1). */
export const IDENTIFIER_VALUE_SYSTEMS = [
  'ORCID', 'ISNI', 'VIAF', 'IPN', 'IPI', 'OCLC', 'ISWC', 'ISRC', 'ISBN', 'DOI', 'EIDR', 'ISAN',
  'WGAWRegistry', 'WGAERegistry', 'USPTOTrademark', 'USPTODesignPatent', 'EUIPOTrademark',
  'EUIPODesign', 'WIPOMadrid', 'WIPOHague', 'UKIPOTrademark', 'UKIPODesign', 'CONA', 'ULAN',
  'ISCC', 'IPTCDigitalImageGUID',
];

/** Identifier URL Sources: used with the Identifier URL form (§2.3.2). */
export const IDENTIFIER_URL_SOURCES = [
  'OfficialPage', 'IMDb', 'Wikidata', 'Wikipedia', 'Instagram', 'TikTok', 'Facebook', 'YouTube',
  'LinkedIn', 'Spotify', 'AppleMusic', 'WorldCat', 'IGDB',
];

type PropertyKind = 'string' | 'date' | 'visual';

export interface SchemaProfile {
  /** Profile Identifier, the required `additionalType` value. */
  readonly id: string;
  /** Section of the registry that defines the profile. */
  readonly section: string;
  readonly subject: SubjectCategory;
  /** Permitted Schema.org `@type` values. */
  readonly types: readonly string[];
  readonly normative: readonly string[];
  readonly additional: readonly string[];
  /** Profile-specific properties and their value forms, beyond the common ones (§2.1). */
  readonly properties: Readonly<Record<string, { readonly kind: PropertyKind; readonly required: boolean }>>;
}

const optional = (kind: PropertyKind) => ({ kind, required: false });
const required = (kind: PropertyKind) => ({ kind, required: true });

const AUDIOVISUAL = ['EIDR', 'ISAN', 'IMDb', 'Wikidata', 'OfficialPage'];
const TRADEMARKS = ['USPTOTrademark', 'EUIPOTrademark', 'WIPOMadrid', 'UKIPOTrademark'];
const DESIGNS = ['USPTODesignPatent', 'EUIPODesign', 'WIPOHague', 'UKIPODesign'];

const profile = (
  key: string,
  section: string,
  subject: SubjectCategory,
  types: string[],
  normative: string[],
  additional: string[],
  properties: SchemaProfile['properties'] = {},
): SchemaProfile => ({
  id: `https://humanconsent.org/schemas/${key}`,
  section,
  subject,
  types,
  normative,
  additional,
  properties,
});

export const SCHEMA_PROFILES: readonly SchemaProfile[] = [
  profile('movie', '3.1', 'work', ['Movie'], AUDIOVISUAL, ['Wikipedia'], { datePublished: optional('date') }),
  profile('television', '3.2', 'work', ['TVSeries', 'TVSeason', 'TVEpisode'], AUDIOVISUAL, ['Wikipedia'], {
    datePublished: optional('date'),
  }),
  profile('game', '3.3', 'work', ['VideoGame', 'VideoGameSeries'], ['EIDR', 'ISAN', 'IMDb', 'IGDB', 'Wikidata', 'OfficialPage'], ['Wikipedia'], {
    datePublished: optional('date'),
  }),
  profile('composition', '3.4', 'work', ['MusicComposition'], ['ISWC', 'Wikidata', 'OfficialPage'], ['VIAF', 'Wikipedia']),
  profile('recording', '3.5', 'work', ['MusicRecording', 'CreativeWork'], ['ISRC', 'Spotify', 'AppleMusic', 'Wikidata', 'OfficialPage'], [
    'YouTube',
    'Wikipedia',
  ]),
  profile('book', '3.6', 'work', ['Book'], ['ISBN', 'DOI', 'OCLC', 'Wikidata', 'OfficialPage'], ['VIAF', 'WorldCat', 'Wikipedia'], {
    datePublished: optional('date'),
  }),
  profile('script', '3.7', 'work', ['CreativeWork'], ['WGAWRegistry', 'WGAERegistry', 'OCLC', 'Wikidata', 'OfficialPage'], [
    'VIAF',
    'WorldCat',
    'Wikipedia',
  ], { version: optional('string') }),
  profile('article', '3.8', 'work', ['Article'], ['DOI', 'OCLC', 'Wikidata', 'OfficialPage'], ['WorldCat', 'Wikipedia'], {
    datePublished: optional('date'),
  }),
  profile('literary', '3.9', 'work', ['CreativeWork'], ['DOI', 'OCLC', 'Wikidata', 'OfficialPage'], ['VIAF', 'WorldCat', 'Wikipedia'], {
    datePublished: optional('date'),
  }),
  profile('photo', '3.10', 'work', ['Photograph'], ['CONA', 'DOI', 'Wikidata', 'Instagram', 'OfficialPage', 'ISCC', 'IPTCDigitalImageGUID'], [
    'OCLC',
    'WorldCat',
    'Wikipedia',
  ], { image: required('visual'), dateCreated: optional('date') }),
  profile('artwork', '3.11', 'work', ['VisualArtwork', 'Painting', 'Sculpture'], ['CONA', 'DOI', 'Wikidata', 'OfficialPage', 'Instagram'], [
    'VIAF',
    'OCLC',
    'WorldCat',
    'Wikipedia',
  ], { image: required('visual'), dateCreated: optional('date') }),
  profile('identity', '3.12', 'identity', ['Person'], [
    'ORCID', 'ISNI', 'VIAF', 'IPN', 'IPI', 'IMDb', 'Wikidata', 'Instagram', 'YouTube', 'TikTok',
    'LinkedIn', 'Facebook', 'Spotify', 'AppleMusic', 'OfficialPage',
  ], ['Wikipedia'], { deathDate: optional('date') }),
  profile('character', '3.13', 'character', ['Person', 'Thing'], ['Wikidata', 'OfficialPage'], ['VIAF', 'Wikipedia'], {
    description: required('string'),
  }),
  // `description` and `logo` are conditional on the mark itself, so only their form is checked.
  profile('trademark', '3.14', 'mark', ['Brand'], [...TRADEMARKS, 'Wikidata', 'OfficialPage'], ['Wikipedia'], {
    description: optional('string'),
    logo: optional('visual'),
  }),
  profile('configuration', '3.15', 'mark', ['Product'], [...DESIGNS, 'Wikidata', 'OfficialPage'], ['Wikipedia'], {
    description: optional('string'),
    image: required('visual'),
  }),
  profile('ornamentation', '3.16', 'mark', ['VisualArtwork'], [...DESIGNS, ...TRADEMARKS, 'Wikidata', 'OfficialPage'], ['Wikipedia'], {
    description: optional('string'),
    image: required('visual'),
  }),
  profile('tradedress', '3.17', 'mark', ['Thing'], [...TRADEMARKS, ...DESIGNS, 'Wikidata', 'OfficialPage'], ['Wikipedia'], {
    description: required('string'),
    image: required('visual'),
  }),
];

export function profileById(id: string): SchemaProfile | undefined {
  return SCHEMA_PROFILES.find((p) => p.id === id);
}

export interface SchemaProblem {
  /** The rule that fails, e.g. "HCS Schema Profiles §2.1". */
  readonly rule: string;
  /** JSON path inside the object, e.g. `identifier[0].url`. */
  readonly at: string;
  readonly message: string;
}

const COMMON = 'HCS Schema Profiles §2.1';
const IDENTIFIERS = 'HCS Schema Profiles §2.2';
const JSON_LD_KEYWORDS = new Set(['@context', '@id', '@type']);
const SCHEMA_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function isVisual(value: unknown): boolean {
  const single = (v: unknown) =>
    (typeof v === 'string' && isHttpsUrl(v)) ||
    (isObject(v) && v['@type'] === 'ImageObject' && typeof v.contentUrl === 'string' && isHttpsUrl(v.contentUrl));
  return Array.isArray(value) ? value.length > 0 && value.every(single) : single(value);
}

function checkKeywords(value: unknown, path: string, problems: SchemaProblem[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkKeywords(item, `${path}[${i}]`, problems));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (key.startsWith('@') && !JSON_LD_KEYWORDS.has(key)) {
        problems.push({ rule: COMMON, at, message: `JSON-LD keyword ${key} is not allowed` });
      }
      checkKeywords(item, at, problems);
    }
  }
}

function checkIdentifiers(identifiers: unknown, profile: SchemaProfile | undefined, problems: SchemaProblem[]): void {
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    problems.push({ rule: IDENTIFIERS, at: 'identifier', message: 'identifier must be a non-empty array' });
    return;
  }
  let hasNormative = false;
  identifiers.forEach((entry, i) => {
    const at = `identifier[${i}]`;
    const problem = (message: string, rule = IDENTIFIERS) => {
      problems.push({ rule, at, message });
    };
    if (!isObject(entry) || entry['@type'] !== 'PropertyValue' || typeof entry.propertyID !== 'string') {
      problem('each identifier must be a PropertyValue with a propertyID');
      return;
    }
    const { propertyID } = entry;
    const hasValue = 'value' in entry;
    const hasUrl = 'url' in entry;
    if (IDENTIFIER_VALUE_SYSTEMS.includes(propertyID)) {
      if (hasUrl || !isNonEmptyString(entry.value)) {
        return problem(`${propertyID} must use the Identifier Value form (a single value string)`, 'HCS Schema Profiles §2.2.1');
      }
    } else if (IDENTIFIER_URL_SOURCES.includes(propertyID)) {
      if (hasValue || typeof entry.url !== 'string' || !isHttpsUrl(entry.url)) {
        return problem(`${propertyID} must use the Identifier URL form (a single HTTPS url)`, 'HCS Schema Profiles §2.2.2');
      }
    } else {
      return problem(`propertyID ${propertyID} is not defined`, 'HCS Schema Profiles §2.3');
    }
    if (profile === undefined) return;
    if (profile.normative.includes(propertyID)) hasNormative = true;
    else if (!profile.additional.includes(propertyID)) {
      problem(`${propertyID} is not supported by ${profile.id}`);
    }
  });
  if (profile !== undefined && !hasNormative) {
    problems.push({ rule: IDENTIFIERS, at: 'identifier', message: 'at least one Normative Identifier is required' });
  }
}

function checkProfileProperties(object: JsonObject, profile: SchemaProfile, problems: SchemaProblem[]): void {
  const rule = `HCS Schema Profiles §${profile.section}.1`;
  for (const [name, { kind, required: isRequired }] of Object.entries(profile.properties)) {
    const value = object[name];
    if (value === undefined) {
      if (isRequired) problems.push({ rule, at: name, message: `${name} is required by ${profile.id}` });
      continue;
    }
    const ok =
      kind === 'string' ? isNonEmptyString(value)
      : kind === 'date' ? typeof value === 'string' && SCHEMA_DATE.test(value)
      : isVisual(value);
    if (!ok) {
      const form =
        kind === 'string' ? 'a single string'
        : kind === 'date' ? 'a single Schema.org Date'
        : 'an HTTPS URL, an ImageObject with an HTTPS contentUrl, or an array of these';
      problems.push({ rule, at: name, message: `${name} must be ${form}` });
    }
  }
}

/** Checks a `<schema>` object of a specific declaration (HCS §3.2.1). */
export function checkRightsSubjectObject(
  value: unknown,
  expected: { readonly subject: SubjectCategory; readonly subjectId: string },
): SchemaProblem[] {
  if (!isObject(value)) return [{ rule: 'HCS §3.2', at: '', message: 'schema must be a JSON object' }];
  const problems: SchemaProblem[] = [];
  checkKeywords(value, '', problems);

  if (value['@context'] !== 'https://schema.org') {
    problems.push({ rule: COMMON, at: '@context', message: '@context must be the string https://schema.org' });
  }
  const canonicalId = CANONICAL_ID_BASE + expected.subjectId;
  if (value['@id'] !== canonicalId) {
    problems.push({ rule: 'HCS §3.2.1', at: '@id', message: `@id must be ${canonicalId}` });
  }

  const profile = typeof value.additionalType === 'string' ? profileById(value.additionalType) : undefined;
  if (profile === undefined) {
    problems.push({ rule: COMMON, at: 'additionalType', message: 'additionalType must be a registered Profile Identifier' });
  } else if (profile.subject !== expected.subject) {
    problems.push({
      rule: 'HCS §3.2.1',
      at: 'additionalType',
      message: `${profile.id} is for subject="${profile.subject}", not "${expected.subject}"`,
    });
  }

  if (typeof value['@type'] !== 'string' || (profile !== undefined && !profile.types.includes(value['@type']))) {
    const allowed = profile === undefined ? 'a single type' : profile.types.join(' or ');
    problems.push({ rule: COMMON, at: '@type', message: `@type must be ${allowed}` });
  }
  if (!isNonEmptyString(value.name)) {
    problems.push({ rule: COMMON, at: 'name', message: 'name must be a single string' });
  }
  const alternateName = value.alternateName;
  if (
    alternateName !== undefined &&
    typeof alternateName !== 'string' &&
    !(Array.isArray(alternateName) && alternateName.every((n) => typeof n === 'string'))
  ) {
    problems.push({ rule: COMMON, at: 'alternateName', message: 'alternateName must be a string or an array of strings' });
  }

  checkIdentifiers(value.identifier, profile, problems);
  if (profile !== undefined) checkProfileProperties(value, profile, problems);
  return problems;
}

/** Checks the `<schema>` object of a Default Declaration (HCS §3.2.2). */
export function checkDefaultDeclarationObject(
  value: unknown,
  expected: { readonly subject: SubjectCategory; readonly subjectClass: string },
): SchemaProblem[] {
  const rule = 'HCS §3.2.2';
  if (!isObject(value)) return [{ rule, at: '', message: 'schema must be a JSON object' }];
  const problems: SchemaProblem[] = [];
  const require = (ok: boolean, at: string, message: string) => {
    if (!ok) problems.push({ rule, at, message });
  };

  require(value['@context'] === 'https://schema.org', '@context', '@context must be the string https://schema.org');
  require(value['@id'] === expected.subjectClass, '@id', '@id must equal the subject-class URL');
  require(value['@type'] === 'Collection', '@type', '@type must be Collection');
  const profile = typeof value.additionalType === 'string' ? profileById(value.additionalType) : undefined;
  require(profile !== undefined, 'additionalType', 'additionalType must be a registered Profile Identifier');
  if (profile !== undefined) {
    require(
      profile.subject === expected.subject,
      'additionalType',
      `${profile.id} is for subject="${profile.subject}", not "${expected.subject}"`,
    );
  }
  require(isNonEmptyString(value.name), 'name', 'name must be a single string');
  require(isNonEmptyString(value.description), 'description', 'description must be a single string');
  return problems;
}
