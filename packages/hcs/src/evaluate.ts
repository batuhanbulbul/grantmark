/**
 * Evaluates one AI use of one Rights Subject against every declaration known for it
 * (HCS 1.0 Draft, 2026-08-08).
 *
 * The steps follow the spec's evaluation order (§3.1.9.7, Figure 1): registry records and
 * authorization, structure and schema, the Rights Subject Record, lifecycle and revalidation,
 * then, for each implicated Rights Scope, the Default/specific, territorial and conflict rules,
 * and finally the RSL license terms. Permission is never inferred from absence (§1.2): a scope
 * that no operative declaration decides is `not_determinable`, which callers must treat as
 * "not permitted".
 *
 * The function is pure. Callers fetch the documents and registry records first.
 */

import { ageStatus, type AgeStatus } from './age';
import { checkDocument, type Declaration, type Finding, type FindingCode, type LicenseTerms } from './conformance';
import { expandGeo } from './countries';
import { collapse } from './lexical';
import { checkLifecycle, type LifecycleCode } from './lifecycle';
import { parseHcsDocument } from './parser';
import { checkRightsSubjectObject, profileById } from './profiles';
import { SUBJECT_SCOPES, type SubjectCategory, type UsageToken } from './vocabulary';

/** HCRN lookup record (§4.3.2). */
export interface HcrnRecord {
  readonly hcrn: string;
  /** Processor-accessible URL of the official Rights Declaration. */
  readonly declarationUrl: string;
  /** URL identifying the Registry. */
  readonly registry: string;
  /**
   * When the current version was first made available at `declarationUrl`, from the registry's
   * history (§4.3.3). Used for the first-observation rule (§3.1.7.2).
   */
  readonly availableSince?: Date | undefined;
}

/** HCSI lookup record (§4.4.3). */
export interface HcsiRecord {
  readonly hcsi: string;
  readonly status: 'active' | 'inactive';
}

/** Governance Board authorization of a Registry (§6.1). */
export interface RegistryAuthorization {
  readonly registry: string;
  readonly authorized: boolean;
  /** Countries the Registry may publish for; absent when it is not territorially limited. */
  readonly territory?: readonly string[] | undefined;
}

/** Registry and Registration Authority records, already fetched by the caller. */
export interface RegistryView {
  hcrnRecord(hcrn: string): HcrnRecord | undefined;
  hcsiRecord(hcsi: string): HcsiRecord | undefined;
  /** The Rights Subject Record (§4.4.2) as parsed JSON, or undefined. */
  subjectRecord(hcsi: string): unknown;
  authorization(registry: string): RegistryAuthorization | undefined;
  /** Whether a Rights Subject belongs to a Subject Class (§3.1.5); undefined if unknown. */
  isMember(subjectClass: string, hcsi: string): boolean | undefined;
}

export interface RetrievedDocument {
  /** The URL the document was retrieved from. */
  readonly url: string;
  readonly content: string | Uint8Array;
  /** When this copy and its records were last validated; defaults to the time of use. */
  readonly validatedAt?: Date | undefined;
}

export interface Use {
  readonly usage: UsageToken;
  /** The time of the use. */
  readonly at: Date;
  /**
   * The Rights Scopes the use implicates. When omitted, every scope of the subject's category is
   * assumed, which is the conservative reading.
   */
  readonly scopes?: readonly string[] | undefined;
  /** ISO 3166-1 alpha-2 code of the place of use; unknown when omitted. */
  readonly place?: string | undefined;
}

/**
 * `require_adult_evidence` (default, Grantmark's policy) refuses every permission path for an
 * identity unless the Rights Subject Record shows an adult. `known_minor_only` applies HCS §1.1
 * only when the record shows a minor.
 */
export type MinorPolicy = 'require_adult_evidence' | 'known_minor_only';

export interface EvaluationInput {
  /** The HCSI of the Rights Subject the use involves. */
  readonly subject: string;
  /** Every retrieved document that may hold declarations for the subject. */
  readonly documents: readonly RetrievedDocument[];
  readonly registry: RegistryView;
  readonly use: Use;
  readonly minorPolicy?: MinorPolicy | undefined;
}

export type RecordCode =
  | 'parse_error'
  | 'hcrn_not_assigned'
  | 'registry_mismatch'
  | 'not_official_copy'
  | 'registry_not_authorized'
  | 'registry_territory'
  | 'hcsi_not_assigned'
  | 'hcsi_inactive'
  | 'subject_record_missing'
  | 'subject_record_invalid'
  | 'subject_record_mismatch'
  | 'component_unsupported';

export type EvaluationCode = FindingCode | LifecycleCode | RecordCode;

export type Decision = 'permitted' | 'permitted_with_terms' | 'prohibited' | 'not_determinable';

export interface LicenseOffer {
  readonly hcrn: string;
  /** 1-based position of the `<license>` in the declaration. */
  readonly license: number;
  readonly terms: LicenseTerms;
  /** License server that must authorize the use first (§3.1.10). */
  readonly server?: string | undefined;
}

export interface DeclarationEvaluation {
  /** Where the document was retrieved from. */
  readonly url: string;
  /** The registration-id as written, if any. */
  readonly hcrn?: string | undefined;
  readonly operative: boolean;
  readonly reasons: readonly Finding<EvaluationCode>[];
  readonly warnings: readonly Finding[];
  readonly declaration?: Declaration | undefined;
  /** For Default Declarations: whether the subject's membership was established (§3.1.5). */
  readonly member?: boolean | undefined;
  /** When the declaration must be revalidated (§3.1.8). */
  readonly revalidateBy?: Date | undefined;
}

export interface ScopeEvaluation {
  /** The Rights Scope, or `*` for subjects without scopes (`mark`). */
  readonly scope: string;
  readonly decision: Decision;
  /** HCRNs of the declarations that decided this scope. */
  readonly governedBy: readonly string[];
  /** Whether `governedBy` are in a Declaration Conflict (§3.1.9). */
  readonly conflict: boolean;
  readonly offers: readonly LicenseOffer[];
  readonly explanation: string;
}

export interface Evaluation {
  readonly usage: UsageToken;
  readonly decision: Decision;
  readonly scopes: readonly ScopeEvaluation[];
  readonly declarations: readonly DeclarationEvaluation[];
  /** License offers that permit the use; empty unless the decision permits it. */
  readonly offers: readonly LicenseOffer[];
  readonly serverAuthorizationRequired: boolean;
  /** Whether the minors rule (§1.1, with Grantmark's policy) removed every permission path. */
  readonly minorProtectionApplied: boolean;
  /** For identity subjects: what the Rights Subject Record shows about age. */
  readonly ageStatus?: AgeStatus | undefined;
}

type Reasons = Finding<EvaluationCode>[];

function checkRecords(d: Declaration, url: string, registry: RegistryView): Reasons {
  const reasons: Reasons = [];
  const add = (code: RecordCode, rule: string, at: string, message: string) => {
    reasons.push({ code, rule, at, message });
  };

  const record = registry.hcrnRecord(d.registrationId);
  if (record === undefined) {
    add('hcrn_not_assigned', 'HCS §4.3.2', '@registration-id', `${d.registrationId} has no HCRN lookup record, so it is not officially assigned`);
  } else {
    if (record.registry !== d.registry) {
      add('registry_mismatch', 'HCS §4.3.2', '@registry', `registry must be ${record.registry}, as in the HCRN lookup record`);
    }
    if (record.declarationUrl !== url) {
      add('not_official_copy', 'HCS §4.3.2', '', `retrieved from ${url}, but the official declaration is at ${record.declarationUrl}`);
    }
  }

  const authorization = registry.authorization(d.registry);
  if (authorization?.authorized !== true) {
    add('registry_not_authorized', 'HCS §6.1', '@registry', `${d.registry} is not an authorized Registry`);
  } else if (authorization.territory !== undefined) {
    const allowed = authorization.territory;
    const outside = d.territory?.filter((code) => !allowed.includes(code));
    if (outside === undefined) {
      add('registry_territory', 'HCS §6.1', '@territory', 'a territorially limited Registry must set territory');
    } else if (outside.length > 0) {
      add('registry_territory', 'HCS §6.1', '@territory', `${outside.join(', ')} is outside the Registry's authorization`);
    }
  }

  if (d.subjectId !== undefined) {
    const hcsi = registry.hcsiRecord(d.subjectId);
    if (hcsi === undefined) {
      add('hcsi_not_assigned', 'HCS §4.4.3', '@subject-id', `${d.subjectId} has no HCSI lookup record`);
    } else if (hcsi.status === 'inactive') {
      add('hcsi_inactive', 'HCS §4.5', '@subject-id', `${d.subjectId} is inactive`);
    }

    const subjectRecord = registry.subjectRecord(d.subjectId);
    if (subjectRecord === undefined) {
      add('subject_record_missing', 'HCS §3.2.3', '@subject-id', `no Rights Subject Record exists for ${d.subjectId}`);
    } else {
      const problems = checkRightsSubjectObject(subjectRecord, { subject: d.subject, subjectId: d.subjectId });
      if (problems.length > 0) {
        add('subject_record_invalid', 'HCS §4.4.2', 'subject-record', `the Rights Subject Record does not conform: ${problems[0]!.message}`);
      }
      const recordObject = subjectRecord as Record<string, unknown>;
      if (recordObject.additionalType !== d.schema.additionalType || recordObject['@type'] !== d.schema['@type']) {
        add('subject_record_mismatch', 'HCS §3.2.1', 'schema', 'additionalType and @type must match the Rights Subject Record');
      }
    }
  }

  if (d.included !== undefined) {
    add('component_unsupported', 'HCS §3.4.3', 'hcs:included', 'Grantmark does not resolve component references yet, so it does not rely on component declarations');
  }
  return reasons;
}

function evaluateDocuments(input: EvaluationInput): DeclarationEvaluation[] {
  const { subject, registry, use } = input;
  const results: DeclarationEvaluation[] = [];
  for (const document of input.documents) {
    const parsed = parseHcsDocument(document.content);
    if (!parsed.ok) {
      results.push({
        url: document.url,
        operative: false,
        reasons: [{ code: 'parse_error', rule: 'HCS §2.2', at: '', message: parsed.error.message }],
        warnings: [],
      });
      continue;
    }
    const checks = checkDocument(parsed.document);
    parsed.document.rights.forEach((right, i) => {
      const subjectId = right.attributes['subject-id'];
      const isDefault = subjectId === undefined && right.attributes['subject-class'] !== undefined;
      if (!isDefault && collapse(subjectId ?? '') !== subject) return;

      const check = checks[i]!;
      const reasons: Reasons = [...check.reasons];
      const declaration = check.declaration;
      let member: boolean | undefined;
      let revalidateBy: Date | undefined;
      if (declaration !== undefined) {
        reasons.push(...checkRecords(declaration, document.url, registry));
        const lifecycle = checkLifecycle(declaration, {
          at: use.at,
          validatedAt: document.validatedAt,
          availableSince: registry.hcrnRecord(declaration.registrationId)?.availableSince,
        });
        reasons.push(...lifecycle.reasons);
        revalidateBy = lifecycle.revalidateBy;
        if (declaration.subjectClass !== undefined) {
          member = registry.isMember(declaration.subjectClass, subject) === true;
        }
      }
      const raw = right.attributes['registration-id'];
      results.push({
        url: document.url,
        hcrn: raw === undefined ? undefined : collapse(raw),
        operative: reasons.length === 0,
        reasons,
        warnings: check.warnings,
        declaration,
        member,
        revalidateBy,
      });
    });
  }
  return results;
}

const covers = (d: Declaration, scope: string) =>
  scope === '*' || d.subjectScope === undefined || d.subjectScope.includes(scope);

const territoriesOverlap = (a: Declaration, b: Declaration) =>
  a.territory === undefined || b.territory === undefined || a.territory.some((c) => b.territory!.includes(c));

/** Declarations that overlap territorially with at least one other in the list. */
const conflicting = (list: readonly Declaration[]) =>
  list.filter((a) => list.some((b) => b !== a && territoriesOverlap(a, b)));

const prohibits = (d: Declaration, usage: UsageToken) => d.licenses.some((l) => l.prohibits.usage?.includes(usage));

function geoAllows(terms: LicenseTerms, place: string | undefined): boolean {
  const { permits, prohibits: denied } = terms;
  if (permits.geo !== undefined && (place === undefined || !expandGeo(permits.geo).has(place))) return false;
  if (denied.geo !== undefined && (place === undefined || expandGeo(denied.geo).has(place))) return false;
  return true;
}

/** An offer with nothing to do: free, and no user, geo or reporting conditions. */
function isUnconditional(terms: LicenseTerms): boolean {
  const { payment } = terms;
  const free =
    payment === undefined ||
    ((payment.type === undefined || payment.type === 'free') &&
      payment.amount === undefined &&
      payment.standard === undefined &&
      payment.custom === undefined &&
      payment.accepts === undefined);
  return (
    free &&
    terms.permits.user === undefined &&
    terms.prohibits.user === undefined &&
    terms.permits.geo === undefined &&
    terms.prohibits.geo === undefined &&
    terms.reporting.length === 0
  );
}

interface ScopeContext {
  readonly usage: UsageToken;
  readonly place: string | undefined;
  readonly minorProtection: boolean;
  readonly ageStatus: AgeStatus | undefined;
}

function scopeResult(
  scope: string,
  decision: Decision,
  governedBy: readonly Declaration[],
  explanation: string,
  options: { conflict?: boolean; offers?: LicenseOffer[] } = {},
): ScopeEvaluation {
  return {
    scope,
    decision,
    governedBy: governedBy.map((d) => d.registrationId),
    conflict: options.conflict ?? false,
    offers: options.offers ?? [],
    explanation,
  };
}

/** What a single governing declaration says about the use in one scope. */
function position(d: Declaration, scope: string, context: ScopeContext): ScopeEvaluation {
  const { usage, place } = context;
  const hcrn = d.registrationId;
  if (prohibits(d, usage)) return scopeResult(scope, 'prohibited', [d], `${hcrn} prohibits ${usage}.`);

  if (context.minorProtection) {
    const explanation =
      context.ageStatus === 'minor'
        ? `Minor protection (HCS §1.1): no permission, payment or license server path in ${hcrn} is operative for a minor's identity.`
        : `Grantmark requires evidence of adulthood before any permission path for an identity, and the Rights Subject Record shows none (stricter than HCS §1.1).`;
    return scopeResult(scope, 'not_determinable', [d], explanation);
  }

  const offers = d.licenses
    .map((terms, i): LicenseOffer => ({ hcrn, license: i + 1, terms, server: d.server }))
    .filter((offer) => offer.terms.permits.usage?.includes(usage) === true && geoAllows(offer.terms, place));
  if (offers.length === 0) {
    const where = place === undefined ? '' : ` in ${place}`;
    return scopeResult(scope, 'not_determinable', [d], `${hcrn} does not permit ${usage}${where}; permission is never inferred (HCS §1.2).`);
  }

  const decision = d.server === undefined && offers.some((o) => isUnconditional(o.terms)) ? 'permitted' : 'permitted_with_terms';
  const via = d.server === undefined ? '' : `, after authorization from ${d.server} (HCS §3.1.10)`;
  const count = offers.length === 1 ? 'one license offer' : `${offers.length} license offers`;
  return scopeResult(scope, decision, [d], `${hcrn} permits ${usage} under ${count}${via}.`, { offers });
}

function evaluateScope(scope: string, operative: readonly Declaration[], context: ScopeContext): ScopeEvaluation {
  const { usage, place } = context;
  const label = scope === '*' ? 'this subject' : `the ${scope} scope`;

  let candidates = operative.filter((d) => covers(d, scope));
  if (place !== undefined) {
    candidates = candidates.filter((d) => d.territory === undefined || d.territory.includes(place));
  }
  if (candidates.length === 0) {
    return scopeResult(scope, 'not_determinable', [], `No operative declaration covers ${label}; permission is never inferred from absence (HCS §1.2).`);
  }

  // A specific declaration applies instead of a Default Declaration where they overlap
  // (§3.1.9.3). With an unknown place, a territorially limited specific declaration leaves the
  // Default Declaration in play outside its territory.
  const specifics = candidates.filter((d) => d.subjectId !== undefined);
  const defaults = candidates.filter((d) => d.subjectClass !== undefined);
  const displaced = specifics.length > 0 && (place !== undefined || specifics.some((d) => d.territory === undefined));
  const pool = displaced ? specifics : [...specifics, ...defaults];

  const inConflict = [...conflicting(specifics), ...(displaced ? [] : conflicting(defaults))];
  if (inConflict.length > 0) {
    const ids = inConflict.map((d) => d.registrationId).join(' and ');
    return scopeResult(
      scope,
      'prohibited',
      inConflict,
      `Declaration Conflict between ${ids} in ${label} (HCS §3.1.9): every usage token is treated as prohibited until it is resolved.`,
      { conflict: true },
    );
  }

  if (place === undefined && pool.some((d) => d.territory !== undefined)) {
    const prohibiting = pool.filter((d) => prohibits(d, usage));
    if (prohibiting.length > 0) {
      return scopeResult(
        scope,
        'prohibited',
        prohibiting,
        `The place of use is unknown, so the prohibition of ${usage} in ${prohibiting.map((d) => d.registrationId).join(', ')} applies (HCS §3.1.6.7).`,
      );
    }
    return scopeResult(
      scope,
      'not_determinable',
      pool,
      'The place of use is unknown, so permissions limited by territory cannot be relied on (HCS §3.1.6.7).',
    );
  }

  return position(pool[0]!, scope, context);
}

const RANK: Readonly<Record<Decision, number>> = {
  permitted: 0,
  permitted_with_terms: 1,
  not_determinable: 2,
  prohibited: 3,
};

/** The subject category a Rights Subject Record's Schema Profile names, if it is a known one. */
function recordCategory(record: unknown): SubjectCategory | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const additionalType = (record as Record<string, unknown>).additionalType;
  return typeof additionalType === 'string' ? profileById(additionalType)?.subject : undefined;
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { subject, registry, use } = input;
  const declarations = evaluateDocuments(input);

  // The category comes from the subject's own record, else from declarations that concern the
  // subject. Unrelated documents (for example a Default Declaration the subject is not a member
  // of) must not decide it: that would switch off the minors rule for a person.
  const record = registry.subjectRecord(subject);
  const concerning = declarations
    .filter((e) => e.declaration !== undefined && (e.declaration.subjectId === subject || e.member === true))
    .map((e) => e.declaration!);
  const category: SubjectCategory | undefined = recordCategory(record) ?? concerning[0]?.subject;
  const scopes = category === 'mark' ? ['*'] : (use.scopes ?? (category === undefined ? [] : SUBJECT_SCOPES[category]));

  const identity = category === 'identity' || concerning.some((d) => d.subject === 'identity');
  const age = identity ? ageStatus(record, use.at) : undefined;
  const policy = input.minorPolicy ?? 'require_adult_evidence';
  const minorProtection = identity && (policy === 'require_adult_evidence' ? age !== 'adult' : age === 'minor');

  const operative = declarations
    .filter((e) => e.operative && (e.declaration?.subjectId === subject || e.member === true))
    .map((e) => e.declaration!);
  const context: ScopeContext = { usage: use.usage, place: use.place, minorProtection, ageStatus: age };
  const scopeResults = scopes.map((scope) => evaluateScope(scope, operative, context));

  const decision = scopeResults.reduce<Decision>(
    (worst, s) => (RANK[s.decision] > RANK[worst] ? s.decision : worst),
    scopeResults.length === 0 ? 'not_determinable' : 'permitted',
  );
  const permits = decision === 'permitted' || decision === 'permitted_with_terms';
  const offers = permits
    ? [...new Map(scopeResults.flatMap((s) => s.offers).map((o) => [`${o.hcrn}#${o.license}`, o])).values()]
    : [];

  return {
    usage: use.usage,
    decision,
    scopes: scopeResults,
    declarations,
    offers,
    serverAuthorizationRequired: offers.some((o) => o.server !== undefined),
    minorProtectionApplied: minorProtection,
    ageStatus: age,
  };
}
