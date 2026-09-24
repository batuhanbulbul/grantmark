/** Vocabularies defined by HCS 1.0 Draft (2026-08-08) and the RSL 1.0 values it reuses. */

/** The only usage tokens allowed inside `<hcs:right>` (HCS §3). */
export const USAGE_TOKENS = ['hcs:ai-generate', 'hcs:ai-train'] as const;
export type UsageToken = (typeof USAGE_TOKENS)[number];

/** `subject` values (HCS §3.1.6.1). */
export const SUBJECT_CATEGORIES = ['work', 'identity', 'character', 'mark'] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

/** `subject-scope` values per category; `mark` allows none (HCS §3.1.6.2). */
export const SUBJECT_SCOPES: Readonly<Record<SubjectCategory, readonly string[]>> = {
  work: ['literary', 'composition', 'recording', 'audio-visual', 'artwork'],
  identity: ['name', 'image', 'likeness', 'voice', 'movement', 'signature'],
  character: ['name', 'visual', 'voice', 'persona'],
  mark: [],
};

/** `status` values (HCS §3.1.7.1). */
export const DECLARATION_STATUSES = ['active', 'withdrawn', 'superseded'] as const;
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number];

/** Canonical identifier URIs are this base plus the identifier (HCS §4.1.3). */
export const CANONICAL_ID_BASE = 'https://id.humanconsent.org/';

/** RSL 1.0 Appendix A vocabularies. Extension values may also be QName tokens where noted. */
export const RSL_USER_TOKENS = ['commercial', 'non-commercial', 'education', 'government', 'personal'];
export const RSL_PAYMENT_TYPES = [
  'purchase',
  'subscription',
  'training',
  'crawl',
  'use',
  'contribution',
  'attribution',
  'free',
];
export const RSL_REPORTING_TYPES = ['telemetry', 'provenance', 'audit'];
export const RSL_WARRANTY_TOKENS = ['ownership', 'authority', 'no-infringement', 'privacy-consent', 'no-malware'];
export const RSL_DISCLAIMER_TOKENS = ['as-is', 'no-warranty', 'no-liability', 'no-indemnity'];
export const RSL_LEGAL_TYPES = ['warranty', 'disclaimer', 'attestation', 'contact', 'proof'];
