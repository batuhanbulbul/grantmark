import { evaluate } from '@grantmark/hcs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { RegistryStore } from '../src/registry/store';
import { registryView, subjectDocuments } from '../src/registry/view';
import { HARBOR_REGISTRY, seedPersonas } from '../src/seed';

const BASE = 'https://grantmark.test';
const config = loadConfig({
  PUBLIC_BASE_URL: BASE,
  REGISTRY_ID: 'https://grantmark.test/registry',
  LICENSE_SERVER_URL: 'https://grantmark.test/olp',
});
const SEEDED_AT = new Date('2026-09-20T10:00:00Z');
const AT = new Date('2026-10-01T12:00:00Z');

function seeded() {
  const store = new RegistryStore(openDatabase(':memory:'), () => SEEDED_AT);
  const result = seedPersonas(store, config);
  return { store, result };
}

function evaluateSubject(store: RegistryStore, subject: string, scopes: string[]) {
  return evaluate({
    subject,
    documents: subjectDocuments(store, BASE, subject),
    registry: registryView(store, BASE),
    use: { usage: 'hcs:ai-generate', at: AT, scopes },
  });
}

describe('seedPersonas', () => {
  it('loads both mock registries, five subjects and six declarations', () => {
    const { store, result } = seeded();
    expect(store.registries().map((r) => r.url)).toEqual([config.registryId, HARBOR_REGISTRY]);
    expect(result.subjects).toEqual([
      'HCSI-0000-0037-X',
      'HCSI-0000-0036-W',
      'HCSI-0000-0034-T',
      'HCSI-0000-0038-Y',
      'HCSI-0000-0035-V',
    ]);
    expect(result.declarations.map((d) => [d.hcrn, d.version, d.changed])).toEqual([
      ['HCRN-0000-006B-J', 1, true],
      ['HCRN-0000-006C-K', 1, true],
      ['HCRN-0000-006A-H', 1, true],
      ['HCRN-0000-0068-F', 1, true],
      ['HCRN-0000-006D-M', 1, true],
      ['HCRN-0000-0069-G', 1, true],
    ]);
  });

  it('replaces the fixture registry and license server with the configured ones', () => {
    const { store } = seeded();
    const xml = new TextDecoder().decode(store.declaration('HCRN-0000-0068-F')!.content);
    expect(xml).toContain(`registry="${config.registryId}"`);
    expect(xml).toContain(`server="${config.licenseServerUrl}"`);
    expect(xml).not.toContain('registry="https://registry.grantmark.example"');
    expect(xml).not.toContain('server="https://license.grantmark.example/olp"');
    // Fictional contact and identifier URLs are left as they are.
    expect(xml).toContain('https://personas.grantmark.example/mira-vale');
    const harbor = new TextDecoder().decode(store.declaration('HCRN-0000-006C-K')!.content);
    expect(harbor).toContain(`registry="${HARBOR_REGISTRY}"`);
  });

  it('is idempotent', () => {
    const { store } = seeded();
    const again = seedPersonas(store, config);
    expect(again.declarations.every((d) => !d.changed && d.version === 1)).toBe(true);
  });
});

describe('checkpoint: the seeded registry drives the evaluator', () => {
  it('mira-vale: permitted with terms through the configured license server', () => {
    const { store } = seeded();
    const result = evaluateSubject(store, 'HCSI-0000-0034-T', ['image', 'likeness']);
    expect(result.declarations.map((d) => d.reasons)).toEqual([[]]);
    expect(result.decision).toBe('permitted_with_terms');
    expect(result.offers.map((o) => o.server)).toEqual([config.licenseServerUrl, config.licenseServerUrl]);
  });

  it('lina-sorel: refused by minor protection', () => {
    const { store } = seeded();
    const result = evaluateSubject(store, 'HCSI-0000-0036-W', ['image']);
    expect(result.minorProtectionApplied).toBe(true);
    expect(result.offers).toEqual([]);
  });

  it('arden-holt: the two registries conflict on likeness', () => {
    const { store } = seeded();
    const result = evaluateSubject(store, 'HCSI-0000-0037-X', ['likeness']);
    expect(result.decision).toBe('prohibited');
    expect(result.scopes[0]?.conflict).toBe(true);
  });

  it('noor-castell and tomas-reyka: nothing permitted', () => {
    const { store } = seeded();
    expect(evaluateSubject(store, 'HCSI-0000-0038-Y', ['image']).decision).toBe('not_determinable');
    expect(evaluateSubject(store, 'HCSI-0000-0035-V', ['image']).decision).toBe('prohibited');
  });

  it('a declaration becomes effective only once published (first-observation rule)', () => {
    const { store } = seeded();
    const before = evaluate({
      subject: 'HCSI-0000-0034-T',
      documents: subjectDocuments(store, BASE, 'HCSI-0000-0034-T'),
      registry: registryView(store, BASE),
      use: { usage: 'hcs:ai-generate', at: new Date('2026-09-10T00:00:00Z'), scopes: ['image'] },
    });
    expect(before.declarations[0]?.reasons.map((r) => r.code)).toEqual(['not_yet_in_force']);
  });
});
