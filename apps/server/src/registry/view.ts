/**
 * Adapts the registry store to the evaluator's inputs, as an HCS processor would see them after
 * fetching the lookup records, declarations and Rights Subject Records.
 */

import type { RegistryView, RetrievedDocument } from '@grantmark/hcs';
import type { RegistryStore } from './store';

export const declarationUrl = (baseUrl: string, hcrn: string) => `${baseUrl}/registry/declarations/${hcrn}`;
export const subjectRecordUrl = (baseUrl: string, hcsi: string) => `${baseUrl}/registry/subjects/${hcsi}`;

export function registryView(store: RegistryStore, baseUrl: string): RegistryView {
  return {
    hcrnRecord(hcrn) {
      const declaration = store.declaration(hcrn);
      return (
        declaration && {
          hcrn,
          declarationUrl: declarationUrl(baseUrl, hcrn),
          registry: declaration.registry,
          availableSince: declaration.firstPublishedAt,
        }
      );
    },
    hcsiRecord(hcsi) {
      const subject = store.subject(hcsi);
      return subject && { hcsi, status: subject.status };
    },
    subjectRecord(hcsi) {
      return store.subject(hcsi)?.record;
    },
    authorization(registry) {
      const stored = store.registry(registry);
      return stored && { registry, authorized: stored.authorized, territory: stored.territory };
    },
    isMember(subjectClass, hcsi) {
      return store.isMember(subjectClass, hcsi);
    },
  };
}

/** The current declarations that may apply to a subject, as retrieved from their official URLs. */
export function subjectDocuments(store: RegistryStore, baseUrl: string, hcsi: string): RetrievedDocument[] {
  return store.declarationsFor(hcsi).map((d) => ({ url: declarationUrl(baseUrl, d.hcrn), content: d.content }));
}
