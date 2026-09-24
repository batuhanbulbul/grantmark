/**
 * Loads the fictional personas into the mock registry.
 *
 * Fixtures name placeholder identifiers for the registry and the license server; seeding swaps
 * them for the configured ones so the `server` attribute points at this deployment.
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { Config } from './config';
import type { PublishResult, RegistryStore } from './registry/store';

export const FIXTURE_REGISTRY = 'https://registry.grantmark.example';
export const FIXTURE_LICENSE_SERVER = 'https://license.grantmark.example/olp';
/** The second, fictional registry that publishes one of the conflicting declarations. */
export const HARBOR_REGISTRY = 'https://registry.harbor-agency.example';

const PERSONAS = new URL('../../../fixtures/personas/', import.meta.url);

export interface SeedResult {
  /** HCSIs of the seeded Rights Subject Records. */
  readonly subjects: string[];
  readonly declarations: PublishResult[];
}

export function seedPersonas(store: RegistryStore, config: Config, personas: URL = PERSONAS): SeedResult {
  store.putRegistry({ url: config.registryId, name: 'Grantmark test registry (mock)', authorized: true });
  store.putRegistry({ url: HARBOR_REGISTRY, name: 'Harbor Agency test registry (mock, fictional)', authorized: true });

  const result: SeedResult = { subjects: [], declarations: [] };
  const names = readdirSync(personas, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const folder = new URL(`${name}/`, personas);
    result.subjects.push(store.putSubject(JSON.parse(readFileSync(new URL('subject.jsonld', folder), 'utf8'))));
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.xml')).sort()) {
      const content = readFileSync(new URL(file, folder), 'utf8')
        .replaceAll(`registry="${FIXTURE_REGISTRY}"`, `registry="${config.registryId}"`)
        .replaceAll(`server="${FIXTURE_LICENSE_SERVER}"`, `server="${config.licenseServerUrl}"`);
      result.declarations.push(store.publish(content));
    }
  }
  return result;
}
