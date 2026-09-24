import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { PublishError, RegistryStore } from '../src/registry/store';

const PERSONAS = new URL('../../../fixtures/personas/', import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, PERSONAS), 'utf8');

const REGISTRY = 'https://registry.grantmark.example';
const MIRA = fixture('mira-vale/declaration.xml');
const MIRA_HCRN = 'HCRN-0000-0068-F';
const MIRA_HCSI = 'HCSI-0000-0034-T';

let clock: Date;
let store: RegistryStore;

beforeEach(() => {
  clock = new Date('2026-09-20T10:00:00Z');
  store = new RegistryStore(openDatabase(':memory:'), () => clock);
  store.putRegistry({ url: REGISTRY, name: 'Grantmark test registry', authorized: true });
});

function publishError(content: string): string {
  try {
    store.publish(content);
  } catch (error) {
    if (error instanceof PublishError) return error.code;
    throw error;
  }
  return 'published';
}

describe('RegistryStore: registries', () => {
  it('stores registries with an optional territory', () => {
    store.putRegistry({ url: 'https://registry.harbor-agency.example', name: 'Harbor', authorized: true, territory: ['DE', 'FR'] });
    expect(store.registry(REGISTRY)).toEqual({ url: REGISTRY, name: 'Grantmark test registry', authorized: true, territory: undefined });
    expect(store.registry('https://registry.harbor-agency.example')?.territory).toEqual(['DE', 'FR']);
    expect(store.registries().map((r) => r.url)).toEqual([REGISTRY, 'https://registry.harbor-agency.example']);
  });

  it('updates a registry in place', () => {
    store.putRegistry({ url: REGISTRY, name: 'Renamed', authorized: false });
    expect(store.registry(REGISTRY)).toMatchObject({ name: 'Renamed', authorized: false });
    expect(store.registries()).toHaveLength(1);
  });
});

describe('RegistryStore: Rights Subject Records', () => {
  const record = JSON.parse(fixture('mira-vale/subject.jsonld'));

  it('stores a record under the HCSI from its @id', () => {
    expect(store.putSubject(record)).toBe(MIRA_HCSI);
    expect(store.subject(MIRA_HCSI)).toEqual({ hcsi: MIRA_HCSI, status: 'active', record });
  });

  it('can mark an HCSI inactive', () => {
    store.putSubject(record, 'inactive');
    expect(store.subject(MIRA_HCSI)?.status).toBe('inactive');
  });

  it.each([
    ['a record without @id', { ...record, '@id': undefined }],
    ['an @id that is not a canonical HCSI URI', { ...record, '@id': 'https://example.com/me' }],
    ['an HCSI with a wrong check symbol', { ...record, '@id': 'https://id.humanconsent.org/HCSI-0000-0034-V' }],
    ['an array', [record]],
  ])('rejects %s', (_label, value) => {
    expect(() => store.putSubject(value)).toThrow(PublishError);
  });
});

describe('RegistryStore: declarations', () => {
  it('publishes version 1 with the exact bytes and the publication time', () => {
    expect(store.publish(MIRA)).toEqual({ hcrn: MIRA_HCRN, version: 1, changed: true });
    const stored = store.declaration(MIRA_HCRN)!;
    expect(new TextDecoder().decode(stored.content)).toBe(MIRA);
    expect(stored).toMatchObject({
      hcrn: MIRA_HCRN,
      version: 1,
      registry: REGISTRY,
      subjectHcsi: MIRA_HCSI,
      subjectClass: undefined,
      firstPublishedAt: new Date('2026-09-20T10:00:00Z'),
    });
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the bytes of byte input, including a byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(MIRA)]);
    store.publish(bytes);
    expect(store.declaration(MIRA_HCRN)?.content).toEqual(bytes);
  });

  it('does not create a new version for identical content', () => {
    store.publish(MIRA);
    clock = new Date('2026-09-21T10:00:00Z');
    expect(store.publish(MIRA)).toEqual({ hcrn: MIRA_HCRN, version: 1, changed: false });
    expect(store.history(MIRA_HCRN)).toHaveLength(1);
  });

  it('keeps every published version and serves the latest', () => {
    store.publish(MIRA);
    clock = new Date('2026-09-22T08:00:00Z');
    const withdrawn = MIRA.replace('max-age="7"', 'max-age="7"\n    status="withdrawn"');
    expect(store.publish(withdrawn)).toEqual({ hcrn: MIRA_HCRN, version: 2, changed: true });
    expect(store.declaration(MIRA_HCRN)?.version).toBe(2);
    expect(store.declaration(MIRA_HCRN)?.firstPublishedAt).toEqual(clock);
    expect(store.history(MIRA_HCRN).map((d) => d.version)).toEqual([1, 2]);
    expect(store.declarations().map((d) => [d.hcrn, d.version])).toEqual([[MIRA_HCRN, 2]]);
  });

  it('lists the current declarations for a subject, plus Default Declarations', () => {
    store.publish(MIRA);
    store.publish(fixture('tomas-reyka/declaration.xml'));
    expect(store.declarationsFor(MIRA_HCSI).map((d) => d.hcrn)).toEqual([MIRA_HCRN]);
    expect(store.declarationsFor('HCSI-0000-0039-Z')).toEqual([]);
  });

  it('records publications in the event log', () => {
    store.publish(MIRA);
    expect(store.events().map((e) => [e.type, e.subject])).toEqual([['declaration_published', MIRA_HCRN]]);
  });

  describe('refuses', () => {
    it.each([
      ['a document that is not XML', 'not xml', 'invalid_declaration'],
      ['a DOCTYPE', `<!DOCTYPE rsl>${MIRA.replace(/^<\?xml[^>]*>/, '')}`, 'invalid_declaration'],
      [
        'a document with two declarations',
        MIRA.replace('</rsl>', `${MIRA.match(/<hcs:right[\s\S]*<\/hcs:right>/)![0].replace(MIRA_HCRN, 'HCRN-0000-006F-P')}</rsl>`),
        'invalid_declaration',
      ],
      ['a non-conforming declaration', MIRA.replace('<legal type="attestation">true</legal>', ''), 'invalid_declaration'],
      ['a declaration from an unknown registry', MIRA.replace(REGISTRY, 'https://registry.unknown.example'), 'unknown_registry'],
    ])('%s', (_label, content, code) => {
      expect(publishError(content)).toBe(code);
    });

    it('an update that changes the Rights Subject (§3.1.2)', () => {
      store.publish(MIRA);
      expect(publishError(MIRA.replace(`subject-id="${MIRA_HCSI}"`, 'subject-id="HCSI-0000-0035-V"').replaceAll(`HCSI-0000-0034-T`, 'HCSI-0000-0035-V'))).toBe(
        'subject_changed',
      );
    });

    it('an update from another registry', () => {
      store.putRegistry({ url: 'https://registry.harbor-agency.example', name: 'Harbor', authorized: true });
      store.publish(MIRA);
      expect(publishError(MIRA.replace(REGISTRY, 'https://registry.harbor-agency.example'))).toBe('registry_changed');
    });
  });
});

describe('RegistryStore: Subject Class membership', () => {
  it('answers true for members and false otherwise', () => {
    store.addMember('https://registry.grantmark.example/classes/members', MIRA_HCSI);
    expect(store.isMember('https://registry.grantmark.example/classes/members', MIRA_HCSI)).toBe(true);
    expect(store.isMember('https://registry.grantmark.example/classes/members', 'HCSI-0000-0035-V')).toBe(false);
  });
});
