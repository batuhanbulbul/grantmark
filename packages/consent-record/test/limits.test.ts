import { describe, expect, it, vi } from 'vitest';
import { checkRecord, checkRecordText, verifyRecord } from '../src/index';
import type { CheckResult, VerifyResult } from '../src/index';
import { LIMITS } from '../src/limits';
import {
  attest,
  digest,
  formatProblems,
  instructionMembers,
  readExample,
  readExampleText,
  rechain,
  sha256Base64url,
  signStatement,
  timeBound,
  type AgreementVersion,
  type ConsentRecord,
  type KeyBinding,
  type RecordEvent,
  type Signature,
  type StatementKind,
} from './helpers';

const AUTHORITY = 'https://authority.example';
const PARTICIPANT = 'p-elin';
const PARTICIPANT_DID = 'did:example:elin-marsh#key-1';
const STUDIO = 'p-twin-studio';
const SUBLICENSEE = 'p-outerwear';
const LIKENESS = 't-likeness-campaign';
const VOICE = 't-voice-ads';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The example's last event is recorded at 2026-10-22T16:45:00Z and its as_of is
// 2026-10-27T12:00:00Z. Every event these tests add falls in between, so as_of and the
// attestation time stay as they are.
const AFTER_EXAMPLE = Date.parse('2026-10-23T00:00:00Z');

// On a dev laptop the scale checks take well under 1 s; at these sizes the cubic checks
// this guards against took tens of seconds.
const SCALE_BOUND_MS = timeBound(5_000);
const BUDGET_BOUND_MS = timeBound(10_000);
const SCHEMA_BOUND_MS = timeBound(1_000);
const BUILD_TIMEOUT = { timeout: 120_000 };

// ---------------------------------------------------------------------------------------
// Time and small helpers

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const pad = (i: number): string => String(i).padStart(3, '0');

/** RFC 3339 in UTC, without fractional seconds when they are zero. */
function instant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Instants `step` apart from `start`, so that `recorded_at` never decreases (R8). */
function clock(start: number, step: number): () => number {
  let next = start;
  return () => {
    const at = next;
    next += step;
    return at;
  };
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

function rules(result: CheckResult | VerifyResult): string[] {
  return result.problems.map((problem) => problem.rule);
}

// ---------------------------------------------------------------------------------------
// The parts of a record these builders change

interface Party {
  party_id: string;
  roles: string[];
  type: string;
  [member: string]: unknown;
}

interface Scope {
  media_types: string[];
  channels: string[];
  territories: { include: string[]; exclude?: string[] };
  exclusivity?: string;
  sublicensing?: { allowed: boolean; to?: string[]; limited_to?: string };
  max_assets?: number;
  named_works?: string[];
  prohibited_contexts?: string[];
}

interface Term {
  term_id: string;
  kind: string;
  [member: string]: unknown;
}

interface Grant extends Term {
  identity_attributes: string[];
  uses: string[];
  scope: Scope;
  licensees: string[];
  valid_from: string;
  valid_until: string;
}

interface Agreement {
  version: number;
  parties: Party[];
  terms: Term[];
  [member: string]: unknown;
}

/** A grant after its narrowings: `term_states[].effective`. */
interface Effective {
  uses: string[];
  identity_attributes: string[];
  scope: Scope;
  licensees: string[];
  valid_from: string;
  valid_until: string;
}

interface TermState {
  term_id: string;
  status: string;
  since: string;
  version: number;
  narrowed: boolean;
  effective?: Effective;
}

interface Narrowing {
  remove_uses?: string[];
  remove_identity_attributes?: string[];
  remove_media_types?: string[];
  remove_channels?: string[];
  remove_territories?: string[];
  add_prohibited_contexts?: string[];
  remove_licensees?: string[];
  remove_sublicensees?: string[];
  forbid_sublicensing?: true;
  restrict_named_works?: string[];
  lower_max_assets?: number;
  end_earlier?: string;
}

function termStates(record: ConsentRecord): TermState[] {
  return record.state['term_states'] as TermState[];
}

function termState(record: ConsentRecord, termId: string): TermState {
  const state = termStates(record).find((entry) => entry.term_id === termId);
  if (state === undefined) throw new Error(`no term state for ${termId}`);
  return state;
}

function freshness(record: ConsentRecord): { max_age_seconds: number; next_change_at?: string } {
  return record.state['freshness'] as { max_age_seconds: number; next_change_at?: string };
}

// ---------------------------------------------------------------------------------------
// Record builders

type EventFields = { type: string; actor: string; recorded_at: string; effective_at: string } & Record<
  string,
  unknown
>;

/** Appends an event with the next `seq`; `seal` sets its `prev_digest`. */
function append(record: ConsentRecord, fields: EventFields): RecordEvent {
  const events = record.state.events;
  const event = { seq: events.length + 1, ...fields, prev_digest: null } as RecordEvent;
  events.push(event);
  return event;
}

/** An event by the authority in charge. It takes effect when it is recorded (R11). */
function authorityEvent(
  record: ConsentRecord,
  at: number,
  fields: Record<string, unknown> & { type: string },
): RecordEvent {
  return append(record, {
    actor: AUTHORITY,
    channel: 'system',
    recorded_at: instant(at),
    effective_at: instant(at),
    ...fields,
  });
}

/** Chains the events again (R8) and renews the attestation (R20). */
function seal(record: ConsentRecord): ConsentRecord {
  return attest(rechain(record));
}

/**
 * The participant's key is bound by its DID (listed in its `identity_binding`); the
 * authority verified every other signer's key when it signed. `verified_at` is then no
 * later than the event that records the signature (R6).
 */
function keyBindingFor(signer: string, signedAt: string): KeyBinding {
  if (signer === PARTICIPANT) {
    return { method: 'did', did_url: PARTICIPANT_DID, custody: 'signer_held', verified_at: signedAt };
  }
  return { method: 'authority_verified', custody: 'signer_held', verified_by: AUTHORITY, verified_at: signedAt };
}

function signedBy(
  record: ConsentRecord,
  statement: StatementKind,
  statementDigest: string,
  signer: string,
  at: number,
): Signature {
  const signedAt = instant(at);
  return {
    ...signStatement(record, statement, statementDigest, signer, signedAt),
    key_binding: keyBindingFor(signer, signedAt),
  };
}

/**
 * Appends version n + 1 and its `version_added` event: the latest version restated with a
 * consent document of its own and `change` applied, signed by the participant, the studio
 * (the only licensee, payer, rights holder and biometric holder of the example) and
 * `extraSigners`. The withdrawn voice grant is left out, since a version names no withdrawn
 * term (R5); dropping it needs no signature (R6).
 */
function addVersion(
  record: ConsentRecord,
  tick: () => number,
  change: (agreement: Agreement) => void = () => {},
  extraSigners: readonly string[] = [],
): void {
  const previous = record.agreements.at(-1)!;
  const n = previous.agreement.version + 1;
  const signers = [PARTICIPANT, STUDIO, ...extraSigners];
  const createdAt = tick();
  const signedAt = signers.map(() => tick());
  const recordedAt = tick();

  const agreement = structuredClone(previous.agreement) as Agreement;
  agreement.version = n;
  agreement['previous_version_digest'] = previous.agreement_digest.value;
  agreement['created_at'] = instant(createdAt);
  agreement['consent_document'] = {
    title: `Digital replica consent, amendment ${n - 1} (fictional)`,
    language: 'en',
    media_type: 'application/pdf',
    digest: { alg: 'sha-256', value: sha256Base64url(`consent document for version ${n}`) },
    presented_at: instant(createdAt),
    signed_at: instant(signedAt[0]!),
    separate_document: true,
  };
  agreement.terms = agreement.terms.filter((term) => term.term_id !== VOICE);
  change(agreement);

  const agreementDigest = digest(agreement);
  const version: AgreementVersion = {
    agreement,
    agreement_digest: { alg: 'sha-256', canonicalization: 'jcs-rfc8785', value: agreementDigest },
    signatures: signers.map((signer, i) => signedBy(record, 'agreement', agreementDigest, signer, signedAt[i]!)),
  };
  record.agreements.push(version);
  authorityEvent(record, recordedAt, { type: 'version_added', version: n, ref_digest: digest(version) });

  const terms = new Set(agreement.terms.map((term) => term.term_id));
  for (const state of termStates(record)) {
    if (terms.has(state.term_id)) state.version = n;
  }
}

/** A narrowing by the participant, received at `at`, in effect then (R11), and signed. */
function participantNarrowing(record: ConsentRecord, at: number, termIds: string[], narrowing: Narrowing): void {
  const receivedAt = instant(at);
  const event = append(record, {
    type: 'narrowed',
    actor: PARTICIPANT,
    channel: 'authority_portal',
    recorded_at: instant(at + 15 * SECOND),
    received_at: receivedAt,
    effective_at: receivedAt,
    term_ids: termIds,
    narrowing,
  });
  const statementDigest = digest(instructionMembers(event));
  event.actor_signature = signedBy(record, 'event_instruction', statementDigest, PARTICIPANT, at - 5 * SECOND);
}

// ---------------------------------------------------------------------------------------
// The effective grant (spec/README.md, "Deriving the state", step 3)

function effectiveOf(grant: Grant): Effective {
  return structuredClone({
    uses: grant.uses,
    identity_attributes: grant.identity_attributes,
    scope: grant.scope,
    licensees: grant.licensees,
    valid_from: grant.valid_from,
    valid_until: grant.valid_until,
  });
}

function without(list: readonly string[], removed: readonly string[]): string[] {
  const gone = new Set(removed);
  return list.filter((value) => !gone.has(value));
}

function narrow(effective: Effective, narrowing: Narrowing): void {
  const scope = effective.scope;
  if (narrowing.remove_uses) effective.uses = without(effective.uses, narrowing.remove_uses);
  if (narrowing.remove_identity_attributes) {
    effective.identity_attributes = without(effective.identity_attributes, narrowing.remove_identity_attributes);
  }
  if (narrowing.remove_media_types) scope.media_types = without(scope.media_types, narrowing.remove_media_types);
  if (narrowing.remove_channels) scope.channels = without(scope.channels, narrowing.remove_channels);
  if (narrowing.remove_territories) {
    if (scope.territories.include.includes('WORLD')) {
      scope.territories.exclude = [...(scope.territories.exclude ?? []), ...narrowing.remove_territories];
    } else {
      scope.territories.include = without(scope.territories.include, narrowing.remove_territories);
    }
  }
  if (narrowing.add_prohibited_contexts) {
    scope.prohibited_contexts = [...(scope.prohibited_contexts ?? []), ...narrowing.add_prohibited_contexts];
  }
  if (narrowing.remove_licensees) effective.licensees = without(effective.licensees, narrowing.remove_licensees);
  if (narrowing.forbid_sublicensing && scope.sublicensing !== undefined) scope.sublicensing = { allowed: false };
  if (narrowing.remove_sublicensees && scope.sublicensing?.to !== undefined) {
    const to = without(scope.sublicensing.to, narrowing.remove_sublicensees);
    scope.sublicensing = to.length > 0 ? { ...scope.sublicensing, to } : { allowed: false };
  }
  if (narrowing.restrict_named_works) {
    const kept = new Set(narrowing.restrict_named_works);
    scope.named_works = scope.named_works?.filter((work) => kept.has(work)) ?? [...narrowing.restrict_named_works];
  }
  if (narrowing.lower_max_assets !== undefined) {
    scope.max_assets = Math.min(scope.max_assets ?? Number.MAX_SAFE_INTEGER, narrowing.lower_max_assets);
  }
  if (narrowing.end_earlier !== undefined && Date.parse(narrowing.end_earlier) < Date.parse(effective.valid_until)) {
    effective.valid_until = narrowing.end_earlier;
  }
}

// ---------------------------------------------------------------------------------------
// Shapes: the example grown by one kind of event each

/**
 * a. `pairs` suspensions of the likeness grant by the authority, each lifted by the
 * authority. The grant is in force again from the last `resumed` event.
 */
function withSuspensions(pairs: number, step = 10 * SECOND): ConsentRecord {
  const record = readExample();
  const tick = clock(AFTER_EXAMPLE, step);
  let resumedAt = 0;
  for (let i = 0; i < pairs; i++) {
    const suspension = authorityEvent(record, tick(), { type: 'suspended', term_ids: [LIKENESS] });
    resumedAt = tick();
    authorityEvent(record, resumedAt, { type: 'resumed', term_ids: [LIKENESS], ref_seq: suspension.seq });
  }
  termState(record, LIKENESS).since = instant(resumedAt);
  return seal(record);
}

const manifestLabel = (j: number) => `urn:c2pa:00000000-0000-4000-8000-${String(j).padStart(12, '0')}`;

/**
 * b. `batches` rounds of `perBatch` bindings under the likeness grant, then their unbinding.
 * The example's own binding stays live, so 79 per round fills the grant's `max_assets` of
 * 80 (R16). A round reuses the previous round's manifest labels, each only after its
 * binding was unbound (R11: an `asset_unbound` takes effect when it is recorded).
 */
function withBindings(batches: number, perBatch: number): ConsentRecord {
  const record = readExample();
  const bindings = record.state.asset_bindings!;
  const claimSigner = structuredClone((bindings[0]!['c2pa'] as { claim_signer: unknown }).claim_signer);
  const tick = clock(AFTER_EXAMPLE, 10 * SECOND);
  for (let b = 0; b < batches; b++) {
    const ids = range(perBatch).map((j) => `bind-${pad(b)}-${pad(j)}`);
    ids.forEach((id, j) => {
      const binding = {
        binding_id: id,
        registered_by: STUDIO,
        term_ids: [LIKENESS],
        media_type: 'image',
        mime_type: 'image/jpeg',
        c2pa: { manifest_label: manifestLabel(j), claim_signer: claimSigner },
      };
      bindings.push(binding);
      authorityEvent(record, tick(), { type: 'asset_bound', channel: 'api', ref: id, ref_digest: digest(binding) });
    });
    for (const id of ids) authorityEvent(record, tick(), { type: 'asset_unbound', channel: 'api', ref: id });
  }
  return seal(record);
}

/** c. `count` more agreement versions, each signed by every signer R6 asks for. */
function withVersions(count: number): ConsentRecord {
  const record = readExample();
  const tick = clock(AFTER_EXAMPLE, MINUTE);
  for (let i = 0; i < count; i++) addVersion(record, tick);
  return seal(record);
}

const USES = range(64).map((i) => `https://uses.example/use-${pad(i)}`);
const ATTRIBUTES = ['name', 'image', 'likeness', 'voice', 'movement', 'mannerisms', 'persona'];
const MEDIA_TYPES = ['image', 'video', 'audio', '3d', 'interactive', 'text'];
const CHANNELS = [
  'web',
  'social',
  'e_commerce',
  'print',
  'broadcast',
  'streaming',
  'out_of_home',
  'in_store',
  'internal',
];
const NAMED_CONTEXTS = [
  'political',
  'adult',
  'religious',
  'tobacco_alcohol_gambling',
  'weapons',
  'health_claims',
  'financial_products',
  'deceptive_or_defamatory',
];
const contextUri = (i: number) => `https://contexts.example/context-${pad(i)}`;
const WORKS = range(256).map((i) => `Work ${pad(i)} (fictional)`);
// Two capital letters match the schema's country code pattern: 676 of them.
const COUNTRY_CODES = range(26 * 26).map((i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)));
const LICENSEES = range(255).map((i) => `p-licensee-${pad(i + 1)}`);
const SUBLICENSEES = range(255).map((i) => `p-sublicensee-${pad(i + 1)}`);

const NEW_GRANTS_FROM = '2026-10-23T01:00:00Z';
const NEW_GRANTS_UNTIL = '2027-09-01T00:00:00Z';

function newGrant(termId: string, change: (grant: Grant) => void): Grant {
  const grant: Grant = {
    term_id: termId,
    kind: 'grant',
    consent_domain: 'identity',
    identity_attributes: ['likeness'],
    uses: ['media.generate'],
    purpose: { description: `Fictional grant ${termId} for the verifier's limit tests.`, categories: ['other'] },
    scope: {
      media_types: ['image'],
      channels: ['web'],
      territories: { include: ['US'] },
      exclusivity: 'non_exclusive',
    },
    licensees: [STUDIO],
    valid_from: NEW_GRANTS_FROM,
    valid_until: NEW_GRANTS_UNTIL,
    withdrawal_right: true,
    compensation: ['c-campaign-fee'],
  };
  change(grant);
  return grant;
}

interface Stream {
  readonly termIds: string[];
  readonly narrowings: Narrowing[];
}

/**
 * d. Version 3 adds grants whose lists are at the schema's `maxItems` (or, without one,
 * long), and the participant then narrows them one value per event until R13 allows no
 * more: every operation, and every value it lists, must change the grant. Adding
 * prohibited contexts (extension URIs), lowering `max_assets` and ending earlier have no
 * list to exhaust, so they run a fixed number of times.
 */
function withNarrowings(): ConsentRecord {
  const record = readExample();
  const grants = [
    newGrant('g-uses-a', (g) => {
      g.uses = [...USES];
      g.identity_attributes = [...ATTRIBUTES];
      g.scope.media_types = [...MEDIA_TYPES];
      g.scope.channels = [...CHANNELS];
      g.scope.max_assets = 1000;
    }),
    newGrant('g-uses-b', (g) => {
      g.uses = [...USES];
      g.identity_attributes = [...ATTRIBUTES];
      g.scope.media_types = [...MEDIA_TYPES];
      g.scope.channels = [...CHANNELS];
    }),
    newGrant('g-licensees', (g) => {
      g.licensees = [STUDIO, ...LICENSEES];
    }),
    newGrant('g-sublicensees', (g) => {
      g.scope.sublicensing = { allowed: true, to: [SUBLICENSEE, ...SUBLICENSEES] };
    }),
    newGrant('g-works', (g) => {
      g.scope.named_works = [...WORKS];
    }),
    newGrant('g-world', (g) => {
      g.scope.territories = { include: ['WORLD'] };
    }),
    newGrant('g-countries', (g) => {
      g.scope.territories = { include: COUNTRY_CODES.slice(0, 300) };
    }),
    newGrant('g-contexts', (g) => {
      g.scope.prohibited_contexts = [...NAMED_CONTEXTS, ...range(56).map(contextUri)];
    }),
  ];
  const newParties: Party[] = [
    ...LICENSEES.map((id) => ({ party_id: id, roles: ['licensee'], type: 'organization' })),
    ...SUBLICENSEES.map((id) => ({ party_id: id, roles: ['sublicensee'], type: 'organization' })),
  ];
  addVersion(
    record,
    clock(AFTER_EXAMPLE, SECOND),
    (agreement) => {
      agreement.parties.push(...newParties);
      agreement.terms.push(...grants);
    },
    LICENSEES,
  );

  const lastEnd = Date.parse(NEW_GRANTS_UNTIL);
  const streams: Stream[] = [
    { termIds: ['g-uses-a', 'g-uses-b'], narrowings: USES.slice(0, 63).map((use) => ({ remove_uses: [use] })) },
    {
      termIds: ['g-uses-a', 'g-uses-b'],
      narrowings: ATTRIBUTES.slice(1).map((a) => ({ remove_identity_attributes: [a] })),
    },
    { termIds: ['g-uses-a', 'g-uses-b'], narrowings: MEDIA_TYPES.slice(1).map((m) => ({ remove_media_types: [m] })) },
    { termIds: ['g-uses-a', 'g-uses-b'], narrowings: CHANNELS.slice(1).map((c) => ({ remove_channels: [c] })) },
    { termIds: ['g-uses-a'], narrowings: range(100).map((i) => ({ lower_max_assets: 999 - i })) },
    { termIds: ['g-licensees'], narrowings: LICENSEES.map((id) => ({ remove_licensees: [id] })) },
    {
      termIds: ['g-sublicensees'],
      narrowings: [...SUBLICENSEES.map((id) => ({ remove_sublicensees: [id] })), { forbid_sublicensing: true }],
    },
    { termIds: ['g-works'], narrowings: range(255).map((i) => ({ restrict_named_works: WORKS.slice(0, 255 - i) })) },
    { termIds: ['g-works'], narrowings: range(100).map((i) => ({ end_earlier: instant(lastEnd - (i + 1) * DAY) })) },
    { termIds: ['g-world'], narrowings: COUNTRY_CODES.slice(0, 300).map((code) => ({ remove_territories: [code] })) },
    {
      termIds: ['g-countries'],
      narrowings: COUNTRY_CODES.slice(0, 299).map((code) => ({ remove_territories: [code] })),
    },
    { termIds: ['g-contexts'], narrowings: range(350).map((i) => ({ add_prohibited_contexts: [contextUri(56 + i)] })) },
  ];

  const effective = new Map(grants.map((grant) => [grant.term_id, effectiveOf(grant)]));
  const tick = clock(Date.parse('2026-10-23T02:00:00Z'), MINUTE);
  // Round robin over the streams, so that the events for each term are spread over the log.
  const longest = Math.max(...streams.map((stream) => stream.narrowings.length));
  for (let i = 0; i < longest; i++) {
    for (const { termIds, narrowings } of streams) {
      const narrowing = narrowings[i];
      if (narrowing === undefined) continue;
      participantNarrowing(record, tick(), termIds, narrowing);
      for (const termId of termIds) narrow(effective.get(termId)!, narrowing);
    }
  }

  for (const grant of grants) {
    termStates(record).push({
      term_id: grant.term_id,
      status: 'in_force',
      since: grant.valid_from,
      version: 3,
      narrowed: true,
      effective: effective.get(grant.term_id)!,
    });
  }
  // The next change is the earliest end among the grants in force.
  const ends = [termState(record, LIKENESS).effective!, ...effective.values()].map((e) => Date.parse(e.valid_until));
  freshness(record).next_change_at = instant(Math.min(...ends));
  return seal(record);
}

/**
 * e. `count` corrections by the authority, each explaining an earlier event. They change no
 * state.
 */
function withCorrections(count: number): ConsentRecord {
  const record = readExample();
  const tick = clock(AFTER_EXAMPLE, 10 * SECOND);
  for (let i = 0; i < count; i++) {
    const seq = record.state.events.length + 1;
    // Alternately an event of the example and the correction just before.
    const refSeq = i % 2 === 0 ? 1 + ((i / 2) % 7) : seq - 1;
    const note = `Correction ${i + 1}: explains event ${refSeq}.`;
    authorityEvent(record, tick(), { type: 'correction', ref_seq: refSeq, note });
  }
  return seal(record);
}

// ---------------------------------------------------------------------------------------
// Nesting

type Nesting = 'arrays' | 'objects' | 'mixed';
const NESTINGS: readonly Nesting[] = ['arrays', 'objects', 'mixed'];

const isArrayLevel = (nesting: Nesting, level: number): boolean =>
  nesting === 'arrays' || (nesting === 'mixed' && level % 2 === 1);

/** A value of exactly `levels` arrays and objects, the outermost being level 1: `[]` has 1. */
function nestedValue(nesting: Nesting, levels: number): unknown {
  let value: unknown = isArrayLevel(nesting, levels) ? [] : {};
  for (let level = levels - 1; level >= 1; level--) value = isArrayLevel(nesting, level) ? [value] : { a: value };
  return value;
}

/** The JSON text of `nestedValue`, built without recursion so that it works at any depth. */
function nestedText(nesting: Nesting, levels: number): string {
  const open: string[] = [];
  const close: string[] = [];
  for (let level = 1; level <= levels; level++) {
    const array = isArrayLevel(nesting, level);
    open.push(array ? '[' : level < levels ? '{"a":' : '{');
    close.push(array ? ']' : '}');
  }
  return open.join('') + close.reverse().join('');
}

// A free JSON value sits three levels into a record: the record, `disclosures` and the
// disclosure entry, or the record, `authority_attestation` and its `jwk` (a public JWK may
// carry members beyond the key's own). The limit counts the record's own levels too.
const LEVELS_ABOVE_FREE_VALUE = 3;
const FREE_KEY = sha256Base64url('a disclosure for the nesting tests');
const MARKER = 'NESTED-VALUE-MARKER';

type Placement = 'a disclosure value' | 'a jwk extension member';
const PLACEMENTS: readonly Placement[] = ['a disclosure value', 'a jwk extension member'];

/**
 * The example with `value` in a free JSON place, below `LEVELS_ABOVE_FREE_VALUE` levels of the
 * record.
 */
function recordWith(placement: Placement, value: unknown): ConsentRecord {
  const record = readExample();
  if (placement === 'a disclosure value') {
    record.disclosures![FREE_KEY] = { salt: 'bmVzdGluZy10ZXN0LXNhbHQ', value };
  } else {
    record.authority_attestation.jwk = { ...record.authority_attestation.jwk, 'x-nested': value };
  }
  return record;
}

/** A record whose whole depth is `levels`, as a parsed value. */
function deepRecord(placement: Placement, nesting: Nesting, levels: number): ConsentRecord {
  return recordWith(placement, nestedValue(nesting, levels - LEVELS_ABOVE_FREE_VALUE));
}

/** A record whose whole depth is `levels`, as text. */
function deepRecordText(placement: Placement, nesting: Nesting, levels: number): string {
  const text = JSON.stringify(recordWith(placement, MARKER));
  return text.replace(`"${MARKER}"`, nestedText(nesting, levels - LEVELS_ABOVE_FREE_VALUE));
}

// ---------------------------------------------------------------------------------------
// Text size

const utf8 = new TextEncoder();
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * The example text with trailing whitespace, `bytes` long in UTF-8. Whitespace is insignificant
 * JSON.
 */
function exampleTextOf(bytes: number): string {
  const text = readExampleText();
  return text + ' '.repeat(bytes - byteLength(text));
}

function expectOnlyLimit(result: CheckResult): void {
  expect(result.problems, formatProblems(result.problems)).toHaveLength(1);
  expect(result.problems[0]!.rule).toBe('limit');
  expect(result.external).toEqual([]);
}

function expectNoLimit(result: CheckResult): void {
  expect(rules(result), formatProblems(result.problems)).not.toContain('limit');
  expect(rules(result)).not.toContain('internal');
}

function expectLimit(result: CheckResult | VerifyResult): void {
  expect(rules(result), formatProblems(result.problems)).toContain('limit');
  expect(rules(result)).not.toContain('internal');
}

// ---------------------------------------------------------------------------------------
// Tests

describe('valid records stay valid at scale', () => {
  const cases: [string, () => ConsentRecord, number][] = [
    ['a. 1000 suspensions, each resumed', () => withSuspensions(1000), 2007],
    ['b. 1027 asset bindings, each unbound', () => withBindings(13, 79), 2061],
    ['c. 150 more agreement versions', () => withVersions(150), 157],
    ['d. narrowings of eight grants down to what R13 allows', withNarrowings, 2005],
    ['e. 2000 corrections', () => withCorrections(2000), 2007],
  ];

  it.each(cases)('%s', BUILD_TIMEOUT, (_name, build, events) => {
    const record = build();
    expect(record.state.events).toHaveLength(events);
    const { value: result, ms } = timed(() => checkRecord(record));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(ms, `the check took ${Math.round(ms)} ms`).toBeLessThan(SCALE_BOUND_MS);
  });
});

describe('text size', () => {
  const limit = LIMITS.textBytes;

  it('refuses a valid record padded to one byte over the limit, as a string and as bytes', () => {
    const text = exampleTextOf(limit + 1);
    expect(byteLength(text)).toBe(limit + 1);
    expectOnlyLimit(checkRecordText(text));
    expectOnlyLimit(checkRecordText(utf8.encode(text)));
  });

  it('counts UTF-8 bytes, not UTF-16 code units, in a string', () => {
    const record = readExample();
    // '€' is one UTF-16 code unit and three UTF-8 bytes.
    record.authority.name = `Authority ${'€'.repeat(4096)}`;
    let text = JSON.stringify(attest(record));
    text += ' '.repeat(limit + 1 - byteLength(text));
    expect(byteLength(text)).toBe(limit + 1);
    expect(text.length).toBeLessThan(limit);
    expectOnlyLimit(checkRecordText(text));
  });

  it('refuses text over the limit that is not JSON, or not UTF-8, by its size alone', () => {
    expectOnlyLimit(checkRecordText('x'.repeat(limit + 1)));
    expectOnlyLimit(checkRecordText(new Uint8Array(limit + 1).fill(0xff)));
  });

  it('does not refuse text of exactly the limit for its length', () => {
    const text = exampleTextOf(limit);
    expect(byteLength(text)).toBe(limit);
    expectNoLimit(checkRecordText(text));
    expectNoLimit(checkRecordText(utf8.encode(text)));
  });
});

describe('nesting', () => {
  const depth = LIMITS.depth;

  describe.each(NESTINGS)('%s', (nesting) => {
    it('as the whole value of checkRecord: 64 levels are within the limit, 65 are not', () => {
      expectNoLimit(checkRecord(nestedValue(nesting, depth)));
      expectLimit(checkRecord(nestedValue(nesting, depth + 1)));
    });

    it('as the whole text of checkRecordText: 64 levels are within the limit, 65 are not', () => {
      expectNoLimit(checkRecordText(nestedText(nesting, depth)));
      expectLimit(checkRecordText(nestedText(nesting, depth + 1)));
    });

    it.each(PLACEMENTS)('in %s: a record 64 levels deep is within the limit, 65 is not', (placement) => {
      expectNoLimit(checkRecord(deepRecord(placement, nesting, depth)));
      expectNoLimit(checkRecordText(deepRecordText(placement, nesting, depth)));
      expectLimit(checkRecord(deepRecord(placement, nesting, depth + 1)));
      expectLimit(checkRecordText(deepRecordText(placement, nesting, depth + 1)));
    });

    it('at 100000 levels: a limit problem, never internal, never a thrown error', () => {
      const levels = 100_000;
      expectLimit(checkRecord(nestedValue(nesting, levels)));
      expectLimit(checkRecordText(nestedText(nesting, levels)));
      for (const placement of PLACEMENTS) {
        expectLimit(checkRecord(deepRecord(placement, nesting, levels)));
        expectLimit(checkRecordText(deepRecordText(placement, nesting, levels)));
      }
    });
  });
});

describe('derivation budget', () => {
  it('stops a record whose checks exceed the work budget with limit problems only, in time', BUILD_TIMEOUT, () => {
    const record = withSuspensions(10_000, 5 * SECOND);
    const { value: result, ms } = timed(() => checkRecord(record));
    // Under the budget the record is valid; over it, every problem is `limit`.
    expect(result.problems.every((problem) => problem.rule === 'limit'), formatProblems(result.problems)).toBe(true);
    expect(ms, `the check took ${Math.round(ms)} ms`).toBeLessThan(BUDGET_BOUND_MS);
  });
});

describe('schema bounds', () => {
  type Holder = (record: ConsentRecord) => object;
  const likeness = (record: ConsentRecord): Grant =>
    (record.agreements[1]!.agreement['terms'] as Grant[]).find((term) => term.term_id === LIKENESS)!;
  const scope: Holder = (r) => likeness(r).scope;
  const narrowing: Holder = (r) => r.state.events[5]!['narrowing'] as object;
  const effective: Holder = (r) => termState(r, LIKENESS).effective!;
  const id = (i: number) => `p-extra-${pad(i)}`;
  const uri = (i: number) => `https://uses.example/extra-${pad(i)}`;
  const text = (i: number) => `Extra work ${pad(i)}`;

  // [array, its maxItems, the object that holds it, its member name, the i-th item]
  const bounds: [string, number, Holder, string, (i: number) => string][] = [
    ['uses on a term', 64, likeness, 'uses', uri],
    ['licensees on a term', 256, likeness, 'licensees', id],
    ['compensation on a term', 64, likeness, 'compensation', id],
    ['named_works in a scope', 256, scope, 'named_works', text],
    ['prohibited_contexts in a scope', 64, scope, 'prohibited_contexts', uri],
    ['sublicensing.to in a scope', 256, (r) => likeness(r).scope.sublicensing!, 'to', id],
    ['term_ids on an event', 256, (r) => r.state.events[5]!, 'term_ids', id],
    ['remove_uses in a narrowing', 64, narrowing, 'remove_uses', uri],
    ['add_prohibited_contexts in a narrowing', 64, narrowing, 'add_prohibited_contexts', uri],
    ['remove_licensees in a narrowing', 256, narrowing, 'remove_licensees', id],
    ['remove_sublicensees in a narrowing', 256, narrowing, 'remove_sublicensees', id],
    ['restrict_named_works in a narrowing', 256, narrowing, 'restrict_named_works', text],
    ['term_ids on an asset binding', 256, (r) => r.state.asset_bindings![0]!, 'term_ids', id],
    ['uses in a term state', 64, effective, 'uses', uri],
    ['licensees in a term state', 256, effective, 'licensees', id],
    ['named_works in a term state', 256, (r) => termState(r, LIKENESS).effective!.scope, 'named_works', text],
  ];

  it.each(bounds)('%s: maxItems passes the schema, one more fails it, quickly', (_name, max, holder, member, item) => {
    const withItems = (n: number): ConsentRecord => {
      const record = readExample();
      (holder(record) as Record<string, unknown>)[member] = range(n).map(item);
      return record;
    };
    expect(rules(checkRecord(withItems(max)))).not.toContain('schema');

    const beyond = withItems(max + 1);
    const { value: result, ms } = timed(() => checkRecord(beyond));
    expect(result.problems.length).toBeGreaterThan(0);
    // R1 to R20 run only on a record that passes R0 and the schema.
    expect(result.problems.every((problem) => problem.rule === 'schema'), formatProblems(result.problems)).toBe(true);
    expect(ms, `the check took ${Math.round(ms)} ms`).toBeLessThan(SCHEMA_BOUND_MS);
  });

  it('rejects 100000 uses on a term with schema problems, quickly', () => {
    const record = readExample();
    likeness(record).uses = range(100_000).map((i) => `https://uses.example/many-${i}`);
    const { value: result, ms } = timed(() => checkRecord(record));
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((problem) => problem.rule === 'schema'), formatProblems(result.problems)).toBe(true);
    expect(ms, `the check took ${Math.round(ms)} ms`).toBeLessThan(SCHEMA_BOUND_MS);
  });
});

describe('verifyRecord on a record beyond a limit', () => {
  const inputs: [string, () => unknown][] = [
    ['text over the size limit', () => exampleTextOf(LIMITS.textBytes + 1)],
    ['bytes over the size limit', () => utf8.encode(exampleTextOf(LIMITS.textBytes + 1))],
    ['a record 65 levels deep', () => deepRecord('a disclosure value', 'arrays', LIMITS.depth + 1)],
    ['a record text 100000 levels deep', () => deepRecordText('a jwk extension member', 'mixed', 100_000)],
  ];

  it.each(inputs)('resolves and reports %s as not valid', async (_name, input) => {
    const keySet = vi.fn(async () => undefined);
    const did = vi.fn(async () => undefined);
    const { value: result, ms } = await timedAsync(() => verifyRecord(input(), { keySet, did }));
    expectLimit(result);
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unchecked).toEqual([]);
    expect(keySet).not.toHaveBeenCalled();
    expect(did).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(BUDGET_BOUND_MS);
  });
});
