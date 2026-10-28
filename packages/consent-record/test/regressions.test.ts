/**
 * Regression tests for inputs that once made the verifier slow or wrong. Each input is the
 * example record, or plain text, grown in one direction and built with the public API only:
 *
 * 1. narrowings recorded in the reverse of their effect order;
 * 2. a record given as a value whose two versions share their term objects;
 * 3. narrowings that remove every country from many grants at once;
 * 4. text that is costly to parse: deep nesting, one long string, one string of escapes;
 * 5. duplicate member names, which only the text shows, found exactly;
 * 6. inputs that are not text, bytes or a plain record;
 * 7. a record given as a value whose JSON text would be over `LIMITS.textBytes`;
 * 8. resolvers that answer `null`;
 * 9. narrowings in effect at many instants: many narrowings of one grant whose effect times
 *    go forward, and many bindings of many narrowed grants;
 * 10. a state that holds at many candidate instants after `as_of`: signed narrowings of many
 *    grants, or of a few grants naming many long works, that take effect after `as_of` and
 *    change nothing, so that R18 compares the state at each of their instants;
 * 11. work per value and per signature: signed narrowings that each keep 255 of the 256 short
 *    Cyrillic works of 256 grants at once, and many suspensions of one grant, each lifted, with
 *    every event signed with an ES384 key, or with Ed25519;
 * 12. long text in every signing statement, and resolver answers read once: a long `record_uri`,
 *    which every signing statement restates; a key set of many keys, named by thousands of
 *    authority signatures; a DID answer, costly or wrong, named by many more signatures than
 *    `LIMITS.problems`; more DID URLs than `LIMITS.resolutions`, one in each signature, which
 *    cannot crowd out the key sets, resolved first, nor change the order of `unchecked`; and
 *    resolvers that throw when called instead of rejecting.
 *
 * A time bound covers the check call alone; building an input may take seconds.
 */
import { createECDH, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkRecord, checkRecordText, LIMITS, verifyRecord } from '../src/index';
import type { CheckResult, ExternalCheck, Jwk, JwkSet, VerifyResult } from '../src/index';
import {
  attest,
  attestedPart,
  base64url,
  digest,
  exampleKey,
  formatProblems,
  instructionMembers,
  jcs,
  keySetResolver,
  readExample,
  readKeySets,
  rechain,
  sha256Base64url,
  signaturesOf,
  signStatement,
  thumbprint,
  type AgreementVersion,
  type ConsentRecord,
  type RecordEvent,
  type Signature,
} from './helpers';

const PARTICIPANT = 'p-elin';
const STUDIO = 'p-twin-studio';
const LIKENESS = 't-likeness-campaign';
const VOICE = 't-voice-ads';

const SECOND = 1000;
/** Building a shape (signing, digests, JSON text) takes up to seconds. */
const TIMEOUT = { timeout: 180_000 };

// ---------------------------------------------------------------------------------------
// Small helpers

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** RFC 3339 in UTC, with milliseconds. */
const iso = (ms: number): string => new Date(ms).toISOString();

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One backslash, written as a code so that no tool or editor can turn it into an escape. */
const BS = String.fromCharCode(92);

interface Checked<T> {
  readonly result: T;
  readonly ms: number;
}

/** Runs one check and times the call alone. A thrown error fails the test. */
function measure<T>(run: () => T): Checked<T> {
  let result: T | undefined;
  let thrown: unknown;
  const start = performance.now();
  try {
    result = run();
  } catch (error) {
    thrown = error;
  }
  const ms = performance.now() - start;
  expect(thrown, 'the check threw').toBeUndefined();
  return { result: result!, ms };
}

/**
 * `measure` for a check that returns a promise: times the call until it settles. A rejection
 * fails the test.
 */
async function measureAsync<T>(run: () => Promise<T>): Promise<Checked<T>> {
  let result: T | undefined;
  let thrown: unknown;
  const start = performance.now();
  try {
    result = await run();
  } catch (error) {
    thrown = error;
  }
  const ms = performance.now() - start;
  expect(thrown, 'the check threw or rejected').toBeUndefined();
  return { result: result!, ms };
}

function rules(result: CheckResult | VerifyResult): string[] {
  return result.problems.map((problem) => problem.rule);
}

/** The rules with their counts, and the first problem cut short: for failure messages. */
function summary(result: CheckResult | VerifyResult): string {
  const counts = new Map<string, number>();
  for (const rule of rules(result)) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  const listed = [...counts].map(([rule, n]) => `${rule}x${n}`).join(' ') || 'valid';
  const first = result.problems[0];
  return first === undefined ? listed : `${listed}; first: ${first.rule} ${first.at} ${first.message.slice(0, 200)}`;
}

function expectNoInternal(result: CheckResult | VerifyResult): void {
  expect(rules(result), summary(result)).not.toContain('internal');
}

function expectFaster({ result, ms }: Checked<CheckResult | VerifyResult>, boundMs: number): void {
  expect(ms, `the check took ${Math.round(ms)} ms (${summary(result)})`).toBeLessThan(boundMs);
}

/** The check got past R0 and the schema, so the rules ran on the shape. */
function expectRulesRan(result: CheckResult): void {
  expect(rules(result), summary(result)).not.toContain('R0');
  expect(rules(result), summary(result)).not.toContain('schema');
}

// ---------------------------------------------------------------------------------------
// The parts of a record these builders change. Everything else stays `unknown`.

interface Party {
  party_id: string;
  roles: string[];
  [member: string]: unknown;
}

interface Scope {
  territories: { include: string[]; exclude?: string[] };
  max_assets?: number;
  [member: string]: unknown;
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
  compensation: string[];
}

interface Compensation {
  compensation_id: string;
  payer?: string;
  [member: string]: unknown;
}

interface EndRule {
  existing_assets: { action: string; within_days: number };
  [member: string]: unknown;
}

interface Agreement {
  version: number;
  parties: Party[];
  terms: Term[];
  compensation: Compensation[];
  end_of_use: { on_withdrawal: EndRule; [member: string]: unknown };
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

function agreementOf(version: AgreementVersion): Agreement {
  return version.agreement as Agreement;
}

function grantOf(version: AgreementVersion, termId: string): Grant {
  const term = agreementOf(version).terms.find((entry) => entry.term_id === termId);
  if (term === undefined) throw new Error(`no term ${termId} in version ${version.agreement.version}`);
  return term as Grant;
}

function termStates(record: ConsentRecord): TermState[] {
  return record.state['term_states'] as TermState[];
}

function setTermState(record: ConsentRecord, state: TermState): void {
  const states = termStates(record);
  const i = states.findIndex((entry) => entry.term_id === state.term_id);
  if (i < 0) throw new Error(`no term state for ${state.term_id}`);
  states[i] = state;
}

function freshness(record: ConsentRecord): { max_age_seconds: number; next_change_at?: string } {
  return record.state['freshness'] as { max_age_seconds: number; next_change_at?: string };
}

/** A grant's text as its effective grant (spec/README.md, "Deriving the state", step 3). */
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

/**
 * Seals a record again after its builder changed it: each version's link to the version
 * before (R1), its digest (R2) and its signatures, key bindings kept (R7); the `ref_digest`
 * of every version event (R9); the event chain (R8); and the attestation (R20). An event's
 * actor signature covers only its instruction members, which this does not change, so it
 * stays as the builder made it. `term_states` and `freshness` stay as the builder left them.
 */
function reseal(record: ConsentRecord): ConsentRecord {
  let previous: string | undefined;
  for (const version of record.agreements) {
    const agreement = version.agreement;
    if (previous !== undefined) agreement['previous_version_digest'] = previous;
    const value = digest(agreement);
    version.agreement_digest.value = value;
    version.signatures = version.signatures.map((signature) => {
      const fresh = signStatement(record, 'agreement', value, signature.signer, signature.signed_at);
      return { ...signature, alg: fresh.alg, jwk: fresh.jwk, kid: fresh.kid, value: fresh.value };
    });
    previous = value;
  }
  for (const event of record.state.events) {
    if (event.type !== 'issued' && event.type !== 'version_added') continue;
    const version = record.agreements[(event['version'] as number) - 1];
    if (version !== undefined) event.ref_digest = digest(version);
  }
  return attest(rechain(record));
}

/**
 * The example's first five events: version 1, the payment and its confirmation, the binding,
 * version 2.
 */
function exampleUpToVersion2(): ConsentRecord {
  const record = readExample();
  record.state.events = record.state.events.slice(0, 5);
  expect(record.state.events.at(-1)!.type).toBe('version_added');
  return record;
}

/**
 * Sets the `term_states` of version 2's likeness and voice grants as they are without the
 * example's events 6 and 7: in force since their `valid_from`, and not narrowed.
 */
function exampleGrantsInForce(record: ConsentRecord): { likeness: Grant; voice: Grant } {
  const version2 = record.agreements[1]!;
  const likeness = grantOf(version2, LIKENESS);
  const voice = grantOf(version2, VOICE);
  for (const grant of [likeness, voice]) {
    setTermState(record, {
      term_id: grant.term_id,
      status: 'in_force',
      since: grant.valid_from,
      version: 2,
      narrowed: false,
      effective: effectiveOf(grant),
    });
  }
  return { likeness, voice };
}

// ---------------------------------------------------------------------------------------
// 1. Narrowings recorded in the reverse of their effect order

const REVERSE_RECORDED_FROM = Date.parse('2026-10-26T12:00:00Z');
const REVERSE_EFFECTIVE_FROM = Date.parse('2026-10-26T00:00:00Z');

/**
 * The example up to version 2, then `count` narrowings of the likeness grant by the
 * participant. Each is recorded 1 ms after the one before but received, and in effect, 1 s
 * earlier, so no narrowing recorded before it is in effect at its instant, while at each
 * instant a different set of narrowings is in effect. Each lowers `max_assets` below the one
 * before; version 2's grant allows `count + 80` assets, so every value changes the grant (R13)
 * and the last is 80. `minimal`: in both versions the grant keeps one value per list.
 *
 * `derive`: `term_states` and `freshness` as spec/README.md, "Deriving the state", gives them.
 * Without the example's narrowing (its event 6) the likeness grant keeps DE, and without its
 * withdrawal (event 7) the voice grant is in force, so its `valid_until` is the next change.
 */
function withReverseNarrowings(count: number, grant: 'example' | 'minimal', derive: boolean): ConsentRecord {
  const record = exampleUpToVersion2();
  const top = count + 80;
  for (const version of record.agreements) {
    const likeness = grantOf(version, LIKENESS);
    if (grant === 'minimal') {
      likeness.identity_attributes = ['likeness'];
      likeness.uses = ['replica.create'];
      likeness.scope = { media_types: ['image'], channels: ['web'], territories: { include: ['US'] }, max_assets: top };
    } else if (version.agreement.version === 2) {
      likeness.scope.max_assets = top;
    }
  }
  for (let j = 0; j < count; j++) {
    const at = iso(REVERSE_EFFECTIVE_FROM - j * SECOND);
    const event: RecordEvent = {
      seq: 6 + j,
      type: 'narrowed',
      recorded_at: iso(REVERSE_RECORDED_FROM + j),
      received_at: at,
      effective_at: at,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [LIKENESS],
      narrowing: { lower_max_assets: top - 1 - j },
      prev_digest: null,
    };
    record.state.events.push(event);
  }
  if (derive) {
    const version2 = record.agreements[1]!;
    const likeness = grantOf(version2, LIKENESS);
    const voice = grantOf(version2, VOICE);
    const effective = effectiveOf(likeness);
    effective.scope.max_assets = top - count;
    setTermState(record, {
      term_id: LIKENESS,
      status: 'in_force',
      since: likeness.valid_from,
      version: 2,
      narrowed: true,
      effective,
    });
    setTermState(record, {
      term_id: VOICE,
      status: 'in_force',
      since: voice.valid_from,
      version: 2,
      narrowed: false,
      effective: effectiveOf(voice),
    });
    expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(likeness.valid_until));
    freshness(record).next_change_at = voice.valid_until;
  }
  return reseal(record);
}

// ---------------------------------------------------------------------------------------
// 2. Versions that share their term objects

const PAYER = 'p-payer2';

/** Every `commitment` value in `value`. */
function commitmentsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) commitmentsIn(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, member] of Object.entries(value)) {
      if (name === 'commitment' && typeof member === 'string') found.add(member);
      else commitmentsIn(member, found);
    }
  }
  return found;
}

/**
 * The example with version 2 built as `{ ...version1, version: 2, end_of_use: other }`, so
 * that both versions hold the same term, party and compensation objects. Version 1's
 * compensation items get a payer of their own, `p-payer2`, which records the payment and
 * signs version 1. Version 2 changes the agreement's `end_of_use`, so the likeness grant,
 * which has no `end_of_use` of its own, changes (R6 compares a grant together with the
 * `end_of_use` that governs it), and with it its compensation item: its payer must sign
 * version 2 and does not. The voice grant has its own `end_of_use` and stays unchanged.
 * Everything else is sealed again, `term_states` follows version 1's text, and disclosures
 * whose commitment version 2 no longer holds are dropped, so that the one problem is R6.
 */
function withSharedTerms(): ConsentRecord {
  const record = readExample();
  const [first, second] = record.agreements;
  if (first === undefined || second === undefined) throw new Error('the example has two versions');
  const version1 = agreementOf(first);

  const studio = version1.parties.find((party) => party.party_id === STUDIO);
  if (studio === undefined) throw new Error(`no party ${STUDIO}`);
  version1.parties.push({ ...structuredClone(studio), party_id: PAYER, roles: ['payer'] });
  for (const item of version1.compensation) if (item.payer === STUDIO) item.payer = PAYER;
  const studioSignature = first.signatures.find((signature) => signature.signer === STUDIO);
  if (studioSignature === undefined) throw new Error(`no signature by ${STUDIO} on version 1`);
  first.signatures.push({ ...structuredClone(studioSignature), signer: PAYER });
  const payment = record.state.events.find((event) => event.type === 'payment_recorded');
  if (payment === undefined) throw new Error('no payment_recorded event');
  payment.actor = PAYER;

  const endOfUse = structuredClone(version1.end_of_use);
  endOfUse.on_withdrawal.existing_assets.within_days = 1;
  const version2: Agreement = { ...version1, version: 2, end_of_use: endOfUse };
  second.agreement = version2;

  // Version 2's terms are version 1's: the likeness grant without DE (the example's
  // narrowing), and the voice grant as it was when withdrawn.
  const likeness = grantOf(first, LIKENESS);
  const effective = effectiveOf(likeness);
  effective.scope.territories.include = effective.scope.territories.include.filter((code) => code !== 'DE');
  termStates(record).find((state) => state.term_id === LIKENESS)!.effective = effective;
  termStates(record).find((state) => state.term_id === VOICE)!.effective = effectiveOf(grantOf(first, VOICE));

  reseal(record);
  const used = commitmentsIn(attestedPart(record));
  record.disclosures = Object.fromEntries(Object.entries(record.disclosures!).filter(([commitment]) => used.has(commitment)));
  return record;
}

// ---------------------------------------------------------------------------------------
// 3. Narrowings that remove every country from many grants

// Two capital letters match the schema's country code pattern: 676 of them.
const COUNTRY_CODES = range(26 * 26).map((i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)));

/**
 * The example up to version 2, whose version 2 adds `grants` grants with `include: ["WORLD"]`;
 * then `events` narrowings by the participant, each naming 256 of those grants (in turn) and
 * removing all 676 country codes and adding 64 prohibited contexts. As in test 1, each is
 * recorded after the one before but in effect 1 s earlier, so each is valid on its own.
 * `term_states` is not derived again.
 */
function withTerritoryNarrowings(events: number, grants: number): ConsentRecord {
  const record = exampleUpToVersion2();
  const version2 = record.agreements[1]!;
  const proto = grantOf(version2, LIKENESS);
  for (let g = 0; g < grants; g++) {
    const grant = structuredClone(proto);
    grant.term_id = `g${g}`;
    grant.identity_attributes = ['likeness'];
    grant.uses = ['replica.create'];
    grant.scope = { media_types: ['image'], channels: ['web'], territories: { include: ['WORLD'] }, max_assets: 80 };
    grant.compensation = ['c-campaign-fee'];
    agreementOf(version2).terms.push(grant);
  }
  const contexts = range(64).map((i) => `https://contexts.example/c${i}`);
  for (let j = 0; j < events; j++) {
    const at = iso(REVERSE_EFFECTIVE_FROM - j * SECOND);
    const event: RecordEvent = {
      seq: 6 + j,
      type: 'narrowed',
      recorded_at: iso(REVERSE_RECORDED_FROM + j),
      received_at: at,
      effective_at: at,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: range(256).map((k) => `g${(j * 256 + k) % grants}`),
      narrowing: { remove_territories: COUNTRY_CODES, add_prohibited_contexts: contexts },
      prev_digest: null,
    };
    record.state.events.push(event);
  }
  return reseal(record);
}

// ---------------------------------------------------------------------------------------
// 5. Duplicate member names in the text

const MARKER = 'REGRESSION-MARKER';

/**
 * The example as compact text, its authority attestation's `jwk` holding one more member,
 * `x-test`, whose value is `valueText`. A JWK may carry members beyond the key's own, and no
 * digest or signature covers this one, so the record stays valid whatever the value is.
 */
function textWithJwkMember(valueText: string): string {
  const record = readExample();
  record.authority_attestation.jwk = { ...record.authority_attestation.jwk, 'x-test': MARKER };
  const text = JSON.stringify(record);
  const placeholder = `"x-test":"${MARKER}"`;
  expect(text.split(placeholder)).toHaveLength(2);
  return text.replace(placeholder, () => `"x-test":${valueText}`);
}

/**
 * The example as compact text with `membersText` written just before the `note` of event 1,
 * a free-text member. JSON.parse keeps the last of two equal names, so the parsed record is
 * the example itself.
 */
function textBeforeNote(membersText: string): string {
  const record = readExample();
  const text = JSON.stringify(record);
  const note = `"note":${JSON.stringify(record.state.events[0]!['note'])}`;
  expect(text.split(note)).toHaveLength(2);
  return text.replace(note, () => `${membersText},${note}`);
}

// ---------------------------------------------------------------------------------------
// 9. Narrowings in effect at many instants

const MINUTE = 60 * SECOND;
const FORWARD_FROM = Date.parse('2026-10-14T00:00:00Z');
const FORWARD_END_FROM = Date.parse('2027-09-01T00:00:00Z');

/**
 * The example up to version 2, then `count` narrowings of the likeness grant by the
 * participant. Narrowing j (from 0) is recorded, received and in effect at
 * 2026-10-14T00:00:00Z plus j minutes, so every narrowing before it is in effect at its
 * instant. It moves the grant's end to 2027-09-01T00:00:00Z minus j minutes: before the end
 * the narrowings before it left, and after its own instant (R13).
 *
 * `derive`: `term_states` and `freshness` as spec/README.md, "Deriving the state", gives them.
 * The likeness grant is in force since its `valid_from` and narrowed: its effective
 * `valid_until` is the last `end_earlier`, which lies after `as_of`. The example's events 6
 * and 7 are not in this record: without the narrowing the likeness grant keeps DE, and
 * without the withdrawal the voice grant is in force, so its `valid_until`, the earliest end
 * after `as_of`, is the next change.
 */
function withForwardNarrowings(count: number, derive: boolean): ConsentRecord {
  const record = exampleUpToVersion2();
  for (let j = 0; j < count; j++) {
    const at = iso(FORWARD_FROM + j * MINUTE);
    const event: RecordEvent = {
      seq: 6 + j,
      type: 'narrowed',
      recorded_at: at,
      received_at: at,
      effective_at: at,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [LIKENESS],
      narrowing: { end_earlier: iso(FORWARD_END_FROM - j * MINUTE) },
      prev_digest: null,
    };
    record.state.events.push(event);
  }
  if (derive) {
    const asOf = Date.parse(record.state.as_of);
    expect(Date.parse(record.state.events.at(-1)!.effective_at)).toBeLessThan(asOf);
    const version2 = record.agreements[1]!;
    const likeness = grantOf(version2, LIKENESS);
    const voice = grantOf(version2, VOICE);
    const effective = effectiveOf(likeness);
    effective.valid_until = iso(FORWARD_END_FROM - (count - 1) * MINUTE);
    setTermState(record, {
      term_id: LIKENESS,
      status: 'in_force',
      since: likeness.valid_from,
      version: 2,
      narrowed: true,
      effective,
    });
    setTermState(record, {
      term_id: VOICE,
      status: 'in_force',
      since: voice.valid_from,
      version: 2,
      narrowed: false,
      effective: effectiveOf(voice),
    });
    expect(Date.parse(voice.valid_until)).toBeGreaterThan(asOf);
    expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(effective.valid_until));
    freshness(record).next_change_at = voice.valid_until;
  }
  return reseal(record);
}

/** The asset binding members these builders change. */
interface Binding {
  binding_id: string;
  term_ids: string[];
  c2pa: { manifest_label: string; hard_binding: { hash: string; [member: string]: unknown }; [member: string]: unknown };
  asset_digest: { value: string; [member: string]: unknown };
  [member: string]: unknown;
}

const BOUND_GRANTS = 256;
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
/**
 * Term ids of two characters (`localId` in the schema), so that a binding naming all of them
 * stays short.
 */
const BOUND_GRANT_IDS = range(BOUND_GRANTS).map((g) => ALPHANUMERIC[Math.floor(g / 36)]! + ALPHANUMERIC[g % 36]!);

const FIRST_NARROWED_AT = '2026-10-14T08:30:00Z';
const FIRST_END = '2027-09-01T00:00:00Z';
const SECOND_SIGNED_AT = '2026-10-14T08:59:40Z';
const SECOND_RECEIVED_AT = '2026-10-14T09:00:00Z';
const SECOND_EFFECTIVE_AT = '2026-10-20T00:00:00Z';
const SECOND_END = '2027-08-01T00:00:00Z';
const BOUND_FROM = Date.parse('2026-10-15T00:00:00Z');
const BOUND_BEFORE_SECOND = '2026-10-16T00:00:00Z';
const BOUND_AFTER_SECOND = '2026-10-21T00:00:00Z';

/**
 * RFC 3339 in UTC, to the second (`ms` a whole second): shorter than `iso` for the many events
 * of a binding test.
 */
const isoSeconds = (ms: number): string => {
  expect(ms % SECOND).toBe(0);
  return iso(ms).replace('.000Z', 'Z');
};

/**
 * The participant's `actor_signature` on `event`, over its instruction members, with the key
 * binding of the example's own signed narrowing (its event 6), verified when received.
 */
function participantSignature(record: ConsentRecord, event: RecordEvent, signedAt: string): Signature {
  const signed = readExample().state.events.find((entry) => entry.actor_signature?.signer === PARTICIPANT);
  const keyBinding = signed?.actor_signature?.key_binding;
  if (keyBinding === undefined) throw new Error(`the example has no event signed by ${PARTICIPANT}`);
  const signature = signStatement(record, 'event_instruction', digest(instructionMembers(event)), PARTICIPANT, signedAt);
  return { ...signature, key_binding: { ...structuredClone(keyBinding), verified_at: event.received_at! } };
}

/**
 * The example up to version 2, whose version 2 adds 256 minimal grants, each a copy of the
 * likeness grant with its own term id; then one narrowing by the participant of all 256,
 * moving their end to 2027-09-01, in effect at 2026-10-14T08:30:00Z; then `bindings` asset
 * bindings, each naming all 256 grants. Each binding is a copy of the example's binding with
 * its own id, manifest label and (placeholder) digests, and has an `asset_bound` event made
 * like the example's: received 40 s before it is recorded. Each binding meets R16 when it takes
 * effect: every grant it names is in force, `p-twin-studio` is a licensee, `image` a media type
 * (as `image/jpeg` asks) and there is no `max_assets`; no other binding has its label.
 *
 * Without `secondNarrowing`, binding i is recorded, and takes effect, at 2026-10-15T00:00:00Z
 * plus i seconds. With it, a second narrowing of all 256 grants, to 2027-08-01, is received
 * and recorded at 2026-10-14T09:00:00Z and, signed by the participant, takes effect on
 * 2026-10-20 (R11). Each binding is still recorded on 2026-10-15, after that narrowing, so the
 * checks judge every binding with both narrowings before it (D21), but the bindings take
 * effect in turn on 2026-10-16, when only the first narrowing is in effect, and on
 * 2026-10-21, when both are. Each takes effect no earlier than it is recorded (R11).
 */
function withBoundGrants(bindings: number, secondNarrowing: boolean): ConsentRecord {
  const record = exampleUpToVersion2();
  const version2 = record.agreements[1]!;
  const proto = grantOf(version2, LIKENESS);
  for (const id of BOUND_GRANT_IDS) {
    const grant = structuredClone(proto);
    grant.term_id = id;
    grant.identity_attributes = ['likeness'];
    grant.uses = ['replica.create'];
    grant.scope = { media_types: ['image'], channels: ['web'], territories: { include: ['US'] } };
    grant.compensation = ['c-campaign-fee'];
    agreementOf(version2).terms.push(grant);
  }

  const events = record.state.events;
  const exampleBound = events.find((event) => event.type === 'asset_bound');
  const exampleBinding = record.state.asset_bindings?.[0];
  if (exampleBound === undefined || exampleBinding === undefined) throw new Error('the example has a binding');
  expect(exampleBound.ref).toBe(exampleBinding.binding_id);

  events.push({
    seq: events.length + 1,
    type: 'narrowed',
    recorded_at: FIRST_NARROWED_AT,
    received_at: FIRST_NARROWED_AT,
    effective_at: FIRST_NARROWED_AT,
    actor: PARTICIPANT,
    channel: 'authority_portal',
    term_ids: [...BOUND_GRANT_IDS],
    narrowing: { end_earlier: FIRST_END },
    prev_digest: null,
  });
  if (secondNarrowing) {
    const second: RecordEvent = {
      seq: events.length + 1,
      type: 'narrowed',
      recorded_at: SECOND_RECEIVED_AT,
      received_at: SECOND_RECEIVED_AT,
      effective_at: SECOND_EFFECTIVE_AT,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [...BOUND_GRANT_IDS],
      narrowing: { end_earlier: SECOND_END },
      prev_digest: null,
    };
    second.actor_signature = participantSignature(record, second, SECOND_SIGNED_AT);
    events.push(second);
  }

  for (let i = 0; i < bindings; i++) {
    const binding = structuredClone(exampleBinding) as Binding;
    binding.binding_id = `bind-${String(i + 2).padStart(4, '0')}`;
    binding.term_ids = [...BOUND_GRANT_IDS];
    binding.c2pa.manifest_label = `urn:c2pa:00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    binding.c2pa.hard_binding.hash = sha256Base64url(`placeholder manifest ${binding.binding_id}`);
    binding.asset_digest.value = sha256Base64url(`placeholder asset ${binding.binding_id}`);
    record.state.asset_bindings!.push(binding);

    const recorded = BOUND_FROM + i * SECOND;
    const effective = !secondNarrowing ? isoSeconds(recorded) : i % 2 === 0 ? BOUND_BEFORE_SECOND : BOUND_AFTER_SECOND;
    events.push({
      ...structuredClone(exampleBound),
      seq: events.length + 1,
      recorded_at: isoSeconds(recorded),
      received_at: isoSeconds(recorded - 40 * SECOND),
      effective_at: effective,
      ref: binding.binding_id,
      ref_digest: digest(binding),
      prev_digest: null,
    });
  }
  if (secondNarrowing) {
    expect(Date.parse(events.at(-1)!.recorded_at)).toBeLessThan(Date.parse(BOUND_BEFORE_SECOND));
  }
  return record;
}

/**
 * `term_states` and `freshness` of `withBoundGrants(n, false)` as spec/README.md, "Deriving the
 * state", gives them. Without the example's events 6 and 7 the likeness and voice grants are
 * in force and not narrowed. Each new grant exists, and is in force, from version 2's effect
 * (step 1; its `valid_from` lies before), and is narrowed: its effective `valid_until` is the
 * narrowing's `end_earlier`. The voice grant's `valid_until` is the earliest end after `as_of`.
 */
function deriveBoundGrants(record: ConsentRecord): ConsentRecord {
  const asOf = Date.parse(record.state.as_of);
  const version2 = record.agreements[1]!;
  const versionEvent = record.state.events.find((event) => event.type === 'version_added' && event['version'] === 2);
  if (versionEvent === undefined) throw new Error('no version event for version 2');
  const { likeness, voice } = exampleGrantsInForce(record);
  for (const id of BOUND_GRANT_IDS) {
    const grant = grantOf(version2, id);
    expect(Date.parse(grant.valid_from)).toBeLessThan(Date.parse(versionEvent.effective_at));
    const effective = effectiveOf(grant);
    effective.valid_until = FIRST_END;
    termStates(record).push({
      term_id: id,
      status: 'in_force',
      since: versionEvent.effective_at,
      version: 2,
      narrowed: true,
      effective,
    });
  }
  expect(Date.parse(voice.valid_until)).toBeGreaterThan(asOf);
  expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(FIRST_END));
  expect(Date.parse(FIRST_END)).toBeLessThan(Date.parse(likeness.valid_until));
  freshness(record).next_change_at = voice.valid_until;
  return record;
}

// ---------------------------------------------------------------------------------------
// 10. A state that holds at many candidate instants after as_of

const HOUR = 60 * MINUTE;
/** Grants a narrowing names: as many as `term_ids` may hold. */
const BATCH = 256;
const LATER_RECORDED_FROM = Date.parse('2026-10-15T00:00:00Z');

/**
 * Term ids in base 36, of one to three characters (`localId` in the schema), so that a
 * narrowing naming 256 of them stays short.
 */
function laterGrantIds(grants: number): string[] {
  return range(grants).map((g) => g.toString(36));
}

/** The batches of at most 256 grants that the narrowings of `withLaterNarrowings` name in turn. */
const laterBatches = (grants: number): number => Math.ceil(grants / BATCH);

/**
 * The code point the long works are made of: U+1F600, an emoji outside the Basic Multilingual
 * Plane.
 */
const ASTRAL_FROM = 0x1f600;
/** Code points of one long work. Each is a surrogate pair in UTF-16 and 4 bytes in UTF-8. */
const WORK_CODE_POINTS = 550;

/**
 * 256 works for grant `g` (below 16), each 550 code points: 547 times U+1F600, then the number
 * `g * 256 + i` of work i in three base-16 digits written as U+1F600 to U+1F60F. So each work is
 * 1100 UTF-16 code units and 2200 bytes of UTF-8, and no two works of any grants are the same.
 * The schema's `named_works` items are `text`, a string of at least one character with no
 * `maxLength`.
 */
function astralWorks(g: number): string[] {
  expect(g).toBeLessThan(16);
  const prefix = new Array<number>(WORK_CODE_POINTS - 3).fill(ASTRAL_FROM);
  return range(BATCH).map((i) => {
    const n = g * BATCH + i;
    return String.fromCodePoint(...prefix, ASTRAL_FROM + (n >> 8), ASTRAL_FROM + ((n >> 4) & 15), ASTRAL_FROM + (n & 15));
  });
}

/**
 * The example up to version 2, whose version 2 adds `grants` minimal grants, each a copy of the
 * likeness grant with its own term id, the uses `replica.create` and `media.generate`, and a
 * short purpose; with `namedWorks`, grant g (from 0) names the works `namedWorks(g)`. Then, for
 * each batch j (from 0) of 256 of them, or of the fewer left at the end, `later` narrowings by
 * the participant that name the batch and remove `media.generate`, then one more. Each
 * narrowing is recorded 1 s after the one before, received when recorded, and signed by the
 * participant 20 s before, so that it may take effect later (R11).
 *
 * Narrowing k (from 1) of batch j takes effect at `as_of` plus `later - k + 1` minutes plus j
 * seconds: after `as_of`, and before every narrowing of the batch recorded before it. Judged
 * against the events before it (D21), none of which is in effect for these grants at its
 * instant, each removes a use the grants still hold (R13). The batch's last narrowing takes
 * effect an hour before `as_of`. So at `as_of` every new grant is narrowed already, each later
 * narrowing removes a use already removed, and the state is the same at each of the
 * `laterBatches(grants) * later` instants after `as_of` at which a narrowing takes effect.
 */
function withLaterNarrowings(grants: number, later: number, namedWorks?: (g: number) => string[]): ConsentRecord {
  const record = exampleUpToVersion2();
  const version2 = record.agreements[1]!;
  const proto = grantOf(version2, LIKENESS);
  const ids = laterGrantIds(grants);
  for (const [g, id] of ids.entries()) {
    const grant = structuredClone(proto);
    grant.term_id = id;
    grant.identity_attributes = ['likeness'];
    grant.uses = ['replica.create', 'media.generate'];
    grant.scope = { media_types: ['image'], channels: ['web'], territories: { include: ['US'] } };
    if (namedWorks !== undefined) grant.scope.named_works = namedWorks(g);
    grant['purpose'] = { description: 'Campaign use.' };
    grant.compensation = ['c-campaign-fee'];
    agreementOf(version2).terms.push(grant);
  }

  const asOf = Date.parse(record.state.as_of);
  const events = record.state.events;
  const narrow = (termIds: string[], effective: number): void => {
    const received = LATER_RECORDED_FROM + (events.length + 1) * SECOND;
    const event: RecordEvent = {
      seq: events.length + 1,
      type: 'narrowed',
      recorded_at: isoSeconds(received),
      received_at: isoSeconds(received),
      effective_at: isoSeconds(effective),
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: termIds,
      narrowing: { remove_uses: ['media.generate'] },
      prev_digest: null,
    };
    event.actor_signature = participantSignature(record, event, isoSeconds(received - 20 * SECOND));
    events.push(event);
  };
  for (let j = 0; j < laterBatches(grants); j++) {
    const batch = ids.slice(j * BATCH, (j + 1) * BATCH);
    for (let k = 1; k <= later; k++) narrow(batch, asOf + (later - k + 1) * MINUTE + j * SECOND);
    narrow(batch, asOf - HOUR);
  }
  expect(Date.parse(events.at(-1)!.recorded_at)).toBeLessThan(asOf);
  return record;
}

/**
 * `term_states` and `freshness` of `withLaterNarrowings(grants, later)` as spec/README.md,
 * "Deriving the state", gives them. Without the example's events 6 and 7 the likeness and voice
 * grants are in force and not narrowed. Each new grant exists, and is in force, from version 2's
 * effect (step 1; its `valid_from` lies before), and is narrowed: at `as_of` its batch's last
 * narrowing is in effect, so its effective grant is its text, named works included, with
 * `replica.create` its only use (step 3). A narrowing in
 * effect after `as_of` removes `media.generate` again and changes nothing, so `term_states` is the
 * same at each of those instants, and the next change (step 7) is the earliest end after
 * `as_of`, the voice grant's `valid_until`. The prohibitions have no end, every new grant ends with
 * the likeness grant, and every narrowing after `as_of` takes effect before the voice grant ends.
 */
function deriveLaterNarrowings(record: ConsentRecord, grants: number, later: number): ConsentRecord {
  const asOf = Date.parse(record.state.as_of);
  const version2 = record.agreements[1]!;
  const versionEvent = record.state.events.find((event) => event.type === 'version_added' && event['version'] === 2);
  if (versionEvent === undefined) throw new Error('no version event for version 2');
  const { likeness, voice } = exampleGrantsInForce(record);
  for (const id of laterGrantIds(grants)) {
    const grant = grantOf(version2, id);
    expect(Date.parse(grant.valid_from)).toBeLessThan(Date.parse(versionEvent.effective_at));
    expect(grant.valid_until).toBe(likeness.valid_until);
    const effective = effectiveOf(grant);
    effective.uses = ['replica.create'];
    termStates(record).push({
      term_id: id,
      status: 'in_force',
      since: versionEvent.effective_at,
      version: 2,
      narrowed: true,
      effective,
    });
  }
  const afterAsOf = record.state.events.map((event) => Date.parse(event.effective_at)).filter((at) => at > asOf);
  expect(new Set(afterAsOf).size).toBe(laterBatches(grants) * later);
  expect(Math.max(...afterAsOf)).toBeLessThan(Date.parse(voice.valid_until));
  expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(likeness.valid_until));
  freshness(record).next_change_at = voice.valid_until;
  return record;
}

/**
 * `withLaterNarrowings(grants, later, namedWorks)` with its state derived, sealed into a valid
 * record.
 */
function laterNarrowingsRecord(grants: number, later: number, namedWorks?: (g: number) => string[]): ConsentRecord {
  return reseal(deriveLaterNarrowings(withLaterNarrowings(grants, later, namedWorks), grants, later));
}

/** `laterNarrowingsRecord(grants, later)` as JSON text. */
function laterNarrowingsText(grants: number, later: number): string {
  return JSON.stringify(laterNarrowingsRecord(grants, later));
}

// ---------------------------------------------------------------------------------------
// 11. Work per value and per signature

/** U+0436, CYRILLIC SMALL LETTER ZHE: the first four characters of every short work. */
const CYRILLIC_ZHE = 0x0436;
/** U+0430, CYRILLIC SMALL LETTER A: the digits of a short work's number run from it to U+043F. */
const CYRILLIC_A = 0x0430;
/** Code points of one short work. */
const SHORT_WORK_CODE_POINTS = 6;

/**
 * 256 works of 6 Cyrillic characters: four times U+0436, then the number i of work i in two
 * base-16 digits written as U+0430 to U+043F. So each work is 6 UTF-16 code units and 12 bytes
 * of UTF-8, and no two are the same.
 */
function cyrillicWorks(): string[] {
  return range(BATCH).map((i) =>
    String.fromCodePoint(CYRILLIC_ZHE, CYRILLIC_ZHE, CYRILLIC_ZHE, CYRILLIC_ZHE, CYRILLIC_A + (i >> 4), CYRILLIC_A + (i & 15)),
  );
}

/**
 * The example up to version 2, whose version 2 adds 256 minimal grants, each a copy of the
 * likeness grant with its own term id, a short purpose and the works of `cyrillicWorks`; then
 * `count` narrowings by the participant, each naming all 256 grants with `restrict_named_works`
 * set to the first 255 works. Narrowing k (from 0) is recorded, and received, at
 * 2026-10-15T00:00:00Z plus k + 1 seconds, signed by the participant 20 s before, and takes
 * effect at 2026-10-26T00:00:00Z minus k seconds: after it is received, which its signature
 * allows (R11), before `as_of`, and before every narrowing recorded before it. Judged against
 * the events before it (D21), none of which is in effect at its instant, each finds the grants
 * naming all 256 works, so it removes one from each, and every work it keeps is one they name
 * (R13).
 *
 * `term_states` and `freshness` as spec/README.md, "Deriving the state", gives them. Without the
 * example's events 6 and 7 the likeness and voice grants are in force and not narrowed. Each new
 * grant exists, and is in force, from version 2's effect (step 1; its `valid_from` lies before),
 * and is narrowed: at `as_of` every narrowing is in effect, so it names the first 255 works
 * (step 3). No event takes effect after `as_of`, so the next change (step 7) is the earliest end
 * after `as_of`, the voice grant's `valid_until`.
 */
function restrictedWorksRecord(count: number): ConsentRecord {
  const record = exampleUpToVersion2();
  const version2 = record.agreements[1]!;
  const proto = grantOf(version2, LIKENESS);
  const ids = laterGrantIds(BATCH);
  const works = cyrillicWorks();
  for (const id of ids) {
    const grant = structuredClone(proto);
    grant.term_id = id;
    grant.identity_attributes = ['likeness'];
    grant.uses = ['replica.create'];
    grant.scope = { media_types: ['image'], channels: ['web'], territories: { include: ['US'] }, named_works: [...works] };
    grant['purpose'] = { description: 'Campaign use.' };
    grant.compensation = ['c-campaign-fee'];
    agreementOf(version2).terms.push(grant);
  }

  const asOf = Date.parse(record.state.as_of);
  const events = record.state.events;
  const kept = works.slice(0, BATCH - 1);
  for (let k = 0; k < count; k++) {
    const received = LATER_RECORDED_FROM + (k + 1) * SECOND;
    const event: RecordEvent = {
      seq: events.length + 1,
      type: 'narrowed',
      recorded_at: isoSeconds(received),
      received_at: isoSeconds(received),
      effective_at: isoSeconds(REVERSE_EFFECTIVE_FROM - k * SECOND),
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [...ids],
      narrowing: { restrict_named_works: [...kept] },
      prev_digest: null,
    };
    event.actor_signature = participantSignature(record, event, isoSeconds(received - 20 * SECOND));
    events.push(event);
  }
  const last = events.at(-1)!;
  expect(Date.parse(last.received_at!)).toBeLessThan(Date.parse(last.effective_at));
  expect(REVERSE_EFFECTIVE_FROM).toBeLessThan(asOf);

  const versionEvent = events.find((event) => event.type === 'version_added' && event['version'] === 2);
  if (versionEvent === undefined) throw new Error('no version event for version 2');
  const { likeness, voice } = exampleGrantsInForce(record);
  for (const id of ids) {
    const grant = grantOf(version2, id);
    expect(Date.parse(grant.valid_from)).toBeLessThan(Date.parse(versionEvent.effective_at));
    const effective = effectiveOf(grant);
    effective.scope.named_works = [...kept];
    termStates(record).push({
      term_id: id,
      status: 'in_force',
      since: versionEvent.effective_at,
      version: 2,
      narrowed: true,
      effective,
    });
  }
  expect(Date.parse(voice.valid_until)).toBeGreaterThan(asOf);
  expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(likeness.valid_until));
  freshness(record).next_change_at = voice.valid_until;
  return reseal(record);
}

/** Makes the participant's `actor_signature` on `event`, as `participantSignature` does. */
type ParticipantSigner = (record: ConsentRecord, event: RecordEvent, signedAt: string) => Signature;

const PAIRS_FROM = Date.parse('2026-10-23T00:00:00Z');

/**
 * The example up to version 2, then `pairs` pairs of events by the participant on the likeness
 * grant: a `suspended` event, then a `resumed` event that lifts it (`ref_seq`). Event i (from 0)
 * of these is recorded, received and in effect at 2026-10-23T00:00:00Z plus i seconds, and
 * carries an `actor_signature` that `signer` makes 20 s before. Each suspension finds the grant
 * in force, and each resumption finds it suspended by the suspension just before it (R13).
 *
 * `term_states` and `freshness` as spec/README.md, "Deriving the state", gives them. Without the
 * example's events 6 and 7 the voice grant is in force and the likeness grant not narrowed.
 * After the last pair the likeness grant is in force again, since that pair's `resumed` event
 * took effect (step 6). No event takes effect after `as_of`, so the next change (step 7) is the
 * earliest end after `as_of`, the voice grant's `valid_until`.
 */
function suspensionPairsRecord(pairs: number, signer: ParticipantSigner): ConsentRecord {
  const record = exampleUpToVersion2();
  const events = record.state.events;
  const first = events.length;
  const push = (type: 'suspended' | 'resumed', refSeq?: number): number => {
    const at = PAIRS_FROM + (events.length - first) * SECOND;
    const event: RecordEvent = {
      seq: events.length + 1,
      type,
      recorded_at: isoSeconds(at),
      received_at: isoSeconds(at),
      effective_at: isoSeconds(at),
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [LIKENESS],
      ...(refSeq === undefined ? {} : { ref_seq: refSeq }),
      prev_digest: null,
    };
    event.actor_signature = signer(record, event, isoSeconds(at - 20 * SECOND));
    events.push(event);
    return event.seq;
  };
  for (let j = 0; j < pairs; j++) {
    const suspension = push('suspended');
    push('resumed', suspension);
  }

  const asOf = Date.parse(record.state.as_of);
  const last = events.at(-1)!;
  expect(last.type).toBe('resumed');
  expect(Date.parse(last.effective_at)).toBeLessThan(asOf);
  const { likeness, voice } = exampleGrantsInForce(record);
  setTermState(record, {
    term_id: LIKENESS,
    status: 'in_force',
    since: last.effective_at,
    version: 2,
    narrowed: false,
    effective: effectiveOf(likeness),
  });
  expect(Date.parse(voice.valid_until)).toBeGreaterThan(asOf);
  expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(likeness.valid_until));
  freshness(record).next_change_at = voice.valid_until;
  return reseal(record);
}

interface Es384Key {
  readonly privateKey: KeyObject;
  readonly jwk: Jwk;
  readonly kid: string;
  /** The verification method of the key's `did` key binding. */
  readonly didUrl: string;
}

/**
 * A P-384 key of the participant, the same in every run: its private scalar is SHA-384 of
 * `grantmark test key: p-elin ES384`. The participant's Ed25519 key is bound by `did` to the
 * verification method `did:example:elin-marsh#key-1`, and a DID URL names one key, so this key
 * is bound to another verification method of the same DID, `#key-es384`. That DID is listed in
 * clear in the participant's `identity_binding` (R6).
 */
function participantEs384Key(): Es384Key {
  const scalar = createHash('sha384').update(`grantmark test key: ${PARTICIPANT} ES384`, 'utf8').digest();
  const ecdh = createECDH('secp384r1');
  ecdh.setPrivateKey(scalar);
  // Uncompressed: 0x04, then x and y of 48 bytes each (RFC 7518 6.2.1.2 and 6.2.1.3).
  const point = ecdh.getPublicKey();
  expect(point).toHaveLength(97);
  const jwk = { kty: 'EC', crv: 'P-384', x: base64url(point.subarray(1, 49)), y: base64url(point.subarray(49)) };
  const privateKey = createPrivateKey({ key: { ...jwk, d: base64url(scalar) }, format: 'jwk' });
  const signed = readExample().state.events.find((entry) => entry.actor_signature?.signer === PARTICIPANT);
  const exampleDidUrl = signed?.actor_signature?.key_binding?.did_url;
  if (exampleDidUrl === undefined) throw new Error(`the example has no did key binding for ${PARTICIPANT}`);
  const did = exampleDidUrl.slice(0, exampleDidUrl.indexOf('#'));
  return { privateKey, jwk, kid: thumbprint(jwk), didUrl: `${did}#key-es384` };
}

/**
 * A `ParticipantSigner` with `participantEs384Key` and ES384: the JWS of `signStatement`, its
 * signature the 96-byte concatenation of R and S (R7), and a `did` key binding held by the
 * signer and verified when the event is received.
 */
function es384Signer(): ParticipantSigner {
  const key = participantEs384Key();
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'ES384', b64: false, crit: ['b64'], kid: key.kid }), 'utf8'));
  return (record, event, signedAt) => {
    const payload = jcs({
      profile: record.profile,
      record_uri: record.record_uri,
      statement: 'event_instruction',
      digest: digest(instructionMembers(event)),
      signer: PARTICIPANT,
      signed_at: signedAt,
    });
    const value = sign('sha384', Buffer.from(`${header}.${payload}`, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(value).toHaveLength(96);
    return {
      signer: PARTICIPANT,
      signed_at: signedAt,
      alg: 'ES384',
      jwk: key.jwk,
      kid: key.kid,
      key_binding: { method: 'did', did_url: key.didUrl, custody: 'signer_held', verified_at: event.received_at! },
      value: `${header}..${base64url(value)}`,
    };
  };
}

// ---------------------------------------------------------------------------------------
// 12. Long text in every signing statement, and resolver answers read once

/**
 * `https://records.example/` and a path of `length` times `a`. The schema's `httpsUri` sets no
 * `maxLength`, and `a` is an unreserved character (RFC 3986 §2.3), so this is a `record_uri` of
 * any length; R10 ties `keys_uri` to the authority's origin, not `record_uri`.
 */
function longRecordUri(length: number): string {
  return `https://records.example/${'a'.repeat(length)}`;
}

/**
 * Gives `record` the `record_uri` `uri`, in the record and in every version's agreement (R1),
 * and makes every signature again over statements that restate it: first each event's
 * `actor_signature`, which must be the participant's Ed25519 one of `participantSignature`, with
 * its `signed_at` and key binding as before; then, through `reseal`, each version's digest and
 * signatures, the `ref_digest` of each version event, the chain and the attestation.
 */
function withRecordUri(record: ConsentRecord, uri: string): ConsentRecord {
  record.record_uri = uri;
  for (const version of record.agreements) version.agreement['record_uri'] = uri;
  for (const event of record.state.events) {
    const signature = event.actor_signature;
    if (signature === undefined) continue;
    if (signature.signer !== PARTICIPANT || signature.alg !== 'Ed25519') {
      throw new Error(`event ${event.seq} is signed by ${signature.signer} with ${signature.alg}`);
    }
    event.actor_signature = participantSignature(record, event, signature.signed_at);
  }
  return reseal(record);
}

/**
 * The example up to version 2, then `count` `suspended` events on the likeness grant, then
 * `count` `resumed` events, the k-th (from 0) lifting the k-th suspension (`ref_seq`): all by
 * the authority in charge, which may suspend a grant and lift its own suspensions (Events).
 * Event i (from 0) of these is recorded, and in effect, at 2026-10-23T00:00:00Z plus i seconds,
 * through the channel `system`. Not being from a party, it has no `received_at` and takes effect
 * when recorded (R11). Each carries an `actor_signature` by the authority with its example key,
 * made as the attestation is (`signStatement`, no key binding), 500 ms before it is recorded
 * (R14). Each suspension finds the grant in force or suspended, and each resumption lifts a
 * suspension in effect that no resumption before it lifted (R13).
 *
 * `term_states` and `freshness` as spec/README.md, "Deriving the state", gives them. Without the
 * example's events 6 and 7 the voice grant is in force and the likeness grant not narrowed. The
 * likeness grant stays suspended until the last resumption lifts the last suspension, and is in
 * force since then (steps 4 and 6). No event takes effect after `as_of`, so the next change
 * (step 7) is the earliest end after `as_of`, the voice grant's `valid_until`.
 */
function authoritySuspensionsRecord(count: number): ConsentRecord {
  const record = exampleUpToVersion2();
  const authority = record.authority.id;
  const events = record.state.events;
  const first = events.length;
  const push = (type: 'suspended' | 'resumed', refSeq?: number): number => {
    const at = PAIRS_FROM + (events.length - first) * SECOND;
    const event: RecordEvent = {
      seq: events.length + 1,
      type,
      recorded_at: isoSeconds(at),
      effective_at: isoSeconds(at),
      actor: authority,
      channel: 'system',
      term_ids: [LIKENESS],
      ...(refSeq === undefined ? {} : { ref_seq: refSeq }),
      prev_digest: null,
    };
    const signedAt = iso(at - SECOND / 2);
    event.actor_signature = signStatement(record, 'event_instruction', digest(instructionMembers(event)), authority, signedAt);
    events.push(event);
    return event.seq;
  };
  const suspensions = range(count).map(() => push('suspended'));
  for (const seq of suspensions) push('resumed', seq);

  const asOf = Date.parse(record.state.as_of);
  const last = events.at(-1)!;
  expect(last.type).toBe('resumed');
  expect(Date.parse(last.effective_at)).toBeLessThan(asOf);
  const { likeness, voice } = exampleGrantsInForce(record);
  setTermState(record, {
    term_id: LIKENESS,
    status: 'in_force',
    since: last.effective_at,
    version: 2,
    narrowed: false,
    effective: effectiveOf(likeness),
  });
  expect(Date.parse(voice.valid_until)).toBeGreaterThan(asOf);
  expect(Date.parse(voice.valid_until)).toBeLessThan(Date.parse(likeness.valid_until));
  freshness(record).next_change_at = voice.valid_until;
  return reseal(record);
}

/** `count` Ed25519 public JWKs without `kid`, each `x` 32 random bytes: keys no signature names. */
function decoyKeys(count: number): Jwk[] {
  return range(count).map(() => ({ kty: 'OKP', crv: 'Ed25519', x: base64url(randomBytes(32)) }));
}

/** The keys of the key set at `keysUri` in key-sets.json. */
function listedKeys(keysUri: string): readonly Jwk[] {
  const set = readKeySets()[keysUri];
  if (set === undefined) throw new Error(`key-sets.json has no ${keysUri}`);
  return set.keys;
}

/**
 * The `did_url` of every `did` key binding in `record`, with the number of signatures bound by
 * it.
 */
function didBindings(record: ConsentRecord): Map<string, number> {
  const bound = new Map<string, number>();
  for (const { signature } of signaturesOf(record)) {
    const binding = signature.key_binding;
    if (binding?.method !== 'did' || binding.did_url === undefined) continue;
    bound.set(binding.did_url, (bound.get(binding.did_url) ?? 0) + 1);
  }
  return bound;
}

/** A DID answer whose thumbprint is costly: an RSA JWK whose `n` is 1,000,000 characters. */
const LONG_RSA_JWK: Jwk = { kty: 'RSA', e: 'AQAB', n: 'A'.repeat(1_000_000) };

/** A fresh Ed25519 public JWK: the key of no signer of any record. */
function freshEd25519Jwk(): Jwk {
  const { x } = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('Ed25519 public key without x');
  return { kty: 'OKP', crv: 'Ed25519', x };
}

/**
 * `participantSignature`, its key binding naming another verification method of the same DID
 * for every event: `did:example:elin-marsh#key-<seq>`. R6 compares only the DID, the part before
 * `#`, with the participant's `identity_binding`. The signature covers the instruction members,
 * not the binding; the chain and the attestation cover the binding (`reseal`).
 */
const didPerEventSignature: ParticipantSigner = (record, event, signedAt) => {
  const signature = participantSignature(record, event, signedAt);
  const binding = signature.key_binding;
  if (binding?.did_url === undefined) throw new Error(`${PARTICIPANT} signs without a did key binding`);
  const did = binding.did_url.slice(0, binding.did_url.indexOf('#'));
  return { ...signature, key_binding: { ...binding, did_url: `${did}#key-${event.seq}` } };
};

// ---------------------------------------------------------------------------------------
// Tests

describe('1. narrowings recorded in the reverse of their effect order', () => {
  const BOUND_MS = 3_000;

  it('1000 narrowings, sealed into a valid record, stay valid', TIMEOUT, () => {
    const record = withReverseNarrowings(1_000, 'example', true);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  it('2000 narrowings of a minimal grant, term states not derived again: no internal problem', TIMEOUT, () => {
    const text = JSON.stringify(withReverseNarrowings(2_000, 'minimal', false));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expectFaster(checked, BOUND_MS);
  });

  it('6000 narrowings of a minimal grant: returns in time, a limit problem allowed', TIMEOUT, () => {
    const text = JSON.stringify(withReverseNarrowings(6_000, 'minimal', false));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expectFaster(checked, BOUND_MS);
  });
});

describe('2. a record given as a value whose versions share their term objects', () => {
  it('gives the problems of its JSON text: the payer missing from version 2 (R6)', TIMEOUT, () => {
    const record = withSharedTerms();
    const [first, second] = record.agreements;
    expect(agreementOf(second!).terms).toBe(agreementOf(first!).terms);
    const text = JSON.stringify(record);

    const fromText = checkRecordText(text);
    const fromValue = checkRecord(record);
    expect(fromValue.problems, formatProblems(fromValue.problems)).toEqual(fromText.problems);
    for (const result of [fromText, fromValue]) {
      expectNoInternal(result);
      const missing = result.problems.filter((problem) => problem.rule === 'R6' && /required signer/.test(problem.message));
      expect(missing, formatProblems(result.problems)).toHaveLength(1);
      expect(missing[0]!.message).toContain(PAYER);
      expect(missing[0]!.at).toMatch(/^\/agreements\/1(\/|$)/);
      expect(rules(result), formatProblems(result.problems)).toEqual(['R6']);
    }
  });
});

describe('3. narrowings with long territory lists', () => {
  it('300 narrowings, each removing 676 countries from 256 of 2560 grants: in time, no internal problem', TIMEOUT, () => {
    const text = JSON.stringify(withTerritoryNarrowings(300, 2_560));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expectFaster(checked, 5_000);
  });
});

describe('4. text that makes JSON.parse costly', () => {
  const nestedArrays = (): string => {
    const n = Math.floor(LIMITS.textBytes / 2);
    return '['.repeat(n) + ']'.repeat(n);
  };
  const nestedObjects = (): string => {
    const n = Math.floor((LIMITS.textBytes - 1) / 6);
    return '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  };

  it.each([
    ['arrays', nestedArrays],
    ['objects', nestedObjects],
  ])('%s nested through the whole size limit: a limit problem on nesting, quickly', TIMEOUT, (_name, build) => {
    const text = build();
    expect(byteLength(text)).toBeLessThanOrEqual(LIMITS.textBytes);
    expect(byteLength(text)).toBeGreaterThan(LIMITS.textBytes - 8);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    const limits = checked.result.problems.filter((problem) => problem.rule === 'limit');
    expect(limits.length, summary(checked.result)).toBeGreaterThan(0);
    expect(limits.some((problem) => /nest/i.test(problem.message)), summary(checked.result)).toBe(true);
    expectFaster(checked, 1_000);
  });

  it('one string of nearly the size limit: returns quickly, no internal problem', TIMEOUT, () => {
    const text = `{"a":"${'x'.repeat(LIMITS.textBytes - 100)}"}`;
    expect(byteLength(text)).toBeLessThanOrEqual(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectFaster(checked, 2_000);
  });

  it('one string of nearly the size limit made of escapes: returns, no internal problem', TIMEOUT, () => {
    const escape = `${BS}n`;
    expect(escape).toHaveLength(2);
    const text = `{"a":"${escape.repeat(Math.floor((LIMITS.textBytes - 100) / 2))}"}`;
    expect(byteLength(text)).toBeLessThanOrEqual(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
  });
});

describe('5. duplicate member names in the text are found exactly', () => {
  const duplicates: [string, () => string][] = [
    ['a name spelled with a Unicode escape, before the same name: note', () => textBeforeNote(`"${BS}u006eote":"x"`)],
    ['"a" and "a" spelled with a Unicode escape, in a JWK member', () => textWithJwkMember(`{"a":1,"${BS}u0061":2}`)],
    ['a string ending in two backslashes, then the same name: note', () => textBeforeNote(`"note":"x${BS.repeat(2)}"`)],
    ['a string ending in four backslashes, then the same name, in a JWK member', () => textWithJwkMember(`{"a":"x${BS.repeat(4)}","a":2}`)],
    [
      'a name with an escaped quote, then the same name with the quote spelled as a Unicode escape',
      () => textWithJwkMember(`{"a${BS}"":1,"a${BS}u0022":2}`),
    ],
  ];

  it.each(duplicates)('%s: one R0 problem, and the parsed record is valid', (_name, build) => {
    const text = build();
    expect(checkRecord(JSON.parse(text)).problems, 'the parsed record').toEqual([]);
    const { result } = measure(() => checkRecordText(text));
    expectNoInternal(result);
    expect(result.problems, formatProblems(result.problems)).toHaveLength(1);
    expect(result.problems[0]!.rule).toBe('R0');
    expect(result.problems[0]!.message).toMatch(/duplicate/i);
  });

  const distinct: [string, () => string][] = [
    [
      'a name inside a string value and the same name in a nested object',
      () => textWithJwkMember(`{"a":"${BS}":${BS}"","b":{"a":1}}`),
    ],
    [
      'a string with an odd run of backslashes before a quote, holding text like a member',
      () => textWithJwkMember(`{"a":"x${BS.repeat(3)}",${BS}"a${BS}":2"}`),
    ],
    ['a name with an escaped quote and the name without it', () => textWithJwkMember(`{"a${BS}"":1,"a":2}`)],
  ];

  it.each(distinct)('%s: no problem', (_name, build) => {
    const { result } = measure(() => checkRecordText(build()));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
  });
});

describe('6. the API never throws', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ] as [string, unknown][])('checkRecordText given %s reports R0', (_name, input) => {
    const { result } = measure(() => checkRecordText(input as never));
    expectNoInternal(result);
    expect(rules(result), summary(result)).toContain('R0');
  });

  it('checkRecord given a Proxy whose traps throw reports a problem', () => {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error('x');
        },
        get() {
          throw new Error('x');
        },
      },
    );
    const { result } = measure(() => checkRecord(hostile));
    expect(result.problems.length, summary(result)).toBeGreaterThan(0);
  });

  // As for the Proxy: index.ts gives `internal` for a value whose reading throws.
  it('checkRecord given the example with a throwing `example` getter reports a problem', () => {
    const record = readExample();
    Object.defineProperty(record, 'example', {
      get() {
        throw new Error('x');
      },
      enumerable: true,
      configurable: true,
    });
    const { result } = measure(() => checkRecord(record));
    expect(result.problems.length, summary(result)).toBeGreaterThan(0);
  });
});

describe('7. the size of a record given as a value', () => {
  const inputs: [string, () => unknown][] = [
    ['600000 doubles', () => new Array<number>(600_000).fill(0.1234567890123)],
    ['a string of 1000000 U+0001 characters', () => String.fromCharCode(1).repeat(1_000_000)],
  ];

  it.each(inputs)('a disclosure value of %s, over the size limit as JSON text: a limit problem, quickly', TIMEOUT, (_name, value) => {
    const record = readExample();
    const commitment = Object.keys(record.disclosures!)[0]!;
    record.disclosures![commitment]!.value = value();
    expect(byteLength(JSON.stringify(record))).toBeGreaterThan(LIMITS.textBytes);
    const checked = measure(() => checkRecord(record));
    expectNoInternal(checked.result);
    expect(rules(checked.result), summary(checked.result)).toContain('limit');
    expectFaster(checked, 1_000);
  });
});

describe('8. resolvers that answer null', () => {
  it('a key set resolver: the key set checks are unchecked as not available', async () => {
    const result = await verifyRecord(readExample(), { keySet: async () => null as never });
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    const reasons = result.unchecked.filter((entry) => entry.check.kind === 'authority_key_set').map((entry) => entry.reason);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).toContain('is not available');
      expect(reason).not.toContain('resolver failed');
    }
  });

  it('a DID resolver: the DID checks are unchecked as not resolved', async () => {
    const result = await verifyRecord(readExample(), { did: async () => null as never });
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    const reasons = result.unchecked.filter((entry) => entry.check.kind === 'did').map((entry) => entry.reason);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).toContain('did not resolve');
      expect(reason).not.toContain('resolver failed');
    }
  });
});

describe('9. narrowings in effect at many instants', () => {
  const BOUND_MS = 3_000;
  /**
   * About as many bindings of 256 grants as fit under `LIMITS.textBytes` with every member of
   * the example's binding and `asset_bound` event: some 2.2 kB each, so 2150 would take 5.0 MB.
   */
  const BINDINGS = 1_750;

  it('4000 narrowings of one grant, each in effect at the next, sealed into a valid record, stay valid', TIMEOUT, () => {
    const text = JSON.stringify(withForwardNarrowings(4_000, true));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  it('6000 such narrowings, term states not derived again: in time, a limit problem allowed', TIMEOUT, () => {
    const text = JSON.stringify(withForwardNarrowings(6_000, false));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expectFaster(checked, BOUND_MS);
  });

  it(`${BINDINGS} bindings each naming 256 narrowed grants, sealed into a valid record, stay valid`, TIMEOUT, () => {
    const text = JSON.stringify(reseal(deriveBoundGrants(withBoundGrants(BINDINGS, false))));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  it(`${BINDINGS} bindings in effect in turn before and after a second narrowing of 256 grants: in time, no internal problem`, TIMEOUT, () => {
    const text = JSON.stringify(reseal(withBoundGrants(BINDINGS, true)));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expectFaster(checked, BOUND_MS);
  });
});

describe('10. a state that holds at many candidate instants after as_of', () => {
  const BOUND_MS = 3_000;
  /**
   * The most grants, a multiple of 256, and later narrowings per batch that keep the text under
   * `LIMITS.textBytes`, with no fewer narrowings than the 52 of a known slow input: 3072 grants
   * and 61 narrowings take 4,172,314 bytes (checked below against a 62nd). 3328 grants would
   * leave room for only 50.
   */
  const GRANTS = 3_072;
  const LATER = 61;

  it('256 grants, each narrowed again at 5 instants after as_of, sealed into a valid record, stay valid', TIMEOUT, () => {
    const text = laterNarrowingsText(256, 5);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  it(`${GRANTS} grants, each narrowed again at ${LATER} instants after as_of, sealed into a valid record: in time, a limit problem allowed`, TIMEOUT, () => {
    expect(byteLength(laterNarrowingsText(GRANTS, LATER + 1))).toBeGreaterThan(LIMITS.textBytes);
    const text = laterNarrowingsText(GRANTS, LATER);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expect(rules(checked.result).filter((rule) => rule !== 'limit'), summary(checked.result)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  /**
   * Few grants whose works are long and outside the Basic Multilingual Plane, the shape of a
   * known slow input: 3 grants, one batch, each naming 256 works of 1100 UTF-16 code units
   * (`astralWorks`), which its effective grant in `term_states` names again; then 380 later
   * narrowings and one before `as_of`.
   */
  const LONG_GRANTS = 3;
  const LONG_LATER = 380;

  it(`${LONG_GRANTS} grants naming 256 works of 1100 UTF-16 code units, narrowed again at ${LONG_LATER} instants after as_of, sealed into a valid record: in time, a limit problem allowed`, TIMEOUT, () => {
    const record = laterNarrowingsRecord(LONG_GRANTS, LONG_LATER, astralWorks);
    const version2 = record.agreements[1]!;
    const works = new Set<string>();
    for (const id of laterGrantIds(LONG_GRANTS)) {
      const named = grantOf(version2, id).scope.named_works as string[];
      expect(named).toHaveLength(BATCH);
      for (const work of named) {
        expect(work).toHaveLength(2 * WORK_CODE_POINTS);
        expect([...work].every((char) => char.codePointAt(0)! >= ASTRAL_FROM), 'a work made of astral characters').toBe(true);
        works.add(work);
      }
      const state = termStates(record).find((entry) => entry.term_id === id);
      expect(state?.effective?.scope.named_works).toEqual(named);
    }
    expect(works.size).toBe(LONG_GRANTS * BATCH);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expect(rules(checked.result).filter((rule) => rule !== 'limit'), summary(checked.result)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });
});

describe('11. per-value and per-signature work', () => {
  const BOUND_MS = 3_000;
  /**
   * Narrowings that each keep 255 of the 256 works of all 256 grants: the shape of a known
   * slow input.
   */
  const RESTRICTIONS = 140;
  /**
   * Pairs of a suspension and the resumption that lifts it: 3900 signed events, with the
   * versions' signatures and the attestation within `LIMITS.signatures`.
   */
  const PAIRS = 1_950;

  it(`256 grants naming 256 works of 6 Cyrillic characters, ${RESTRICTIONS} signed narrowings each keeping 255 of them in all 256 grants, sealed into a valid record: in time, a limit problem allowed`, TIMEOUT, () => {
    const record = restrictedWorksRecord(RESTRICTIONS);
    const version2 = record.agreements[1]!;
    const works = new Set<string>();
    for (const id of laterGrantIds(BATCH)) {
      const named = grantOf(version2, id).scope.named_works as string[];
      expect(named).toHaveLength(BATCH);
      for (const work of named) {
        const codePoints = [...work].map((char) => char.codePointAt(0)!);
        expect(codePoints).toHaveLength(SHORT_WORK_CODE_POINTS);
        expect(codePoints.every((code) => code >= 0x0400 && code <= 0x04ff), 'a work made of Cyrillic characters').toBe(true);
        works.add(work);
      }
    }
    expect(works.size).toBe(BATCH);
    const narrowings = record.state.events.filter((event) => event.type === 'narrowed');
    expect(narrowings).toHaveLength(RESTRICTIONS);
    for (const event of narrowings) {
      expect(event.actor_signature?.signer).toBe(PARTICIPANT);
      expect(event['term_ids']).toHaveLength(BATCH);
    }
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expect(rules(checked.result).filter((rule) => rule !== 'limit'), summary(checked.result)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  it(`${PAIRS} suspensions of one grant, each lifted, every event signed with an ES384 key, sealed into a valid record: in time, a limit problem allowed`, TIMEOUT, () => {
    const record = suspensionPairsRecord(PAIRS, es384Signer());
    const pairEvents = record.state.events.filter((event) => event.type === 'suspended' || event.type === 'resumed');
    expect(pairEvents).toHaveLength(2 * PAIRS);
    expect(pairEvents.every((event) => event.actor_signature?.alg === 'ES384'), 'every event signed with ES384').toBe(true);
    expect(signaturesOf(record).length).toBeLessThanOrEqual(LIMITS.signatures);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expect(rules(checked.result).filter((rule) => rule !== 'limit'), summary(checked.result)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });

  // The two shapes above may stop at a limit, which would hide a builder mistake: small ones
  // stay valid.
  it('8 such narrowings and 50 such ES384 pairs, sealed into valid records, stay valid', TIMEOUT, () => {
    for (const record of [restrictedWorksRecord(8), suspensionPairsRecord(50, es384Signer())]) {
      const checked = measure(() => checkRecordText(JSON.stringify(record)));
      expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    }
  });

  it(`${PAIRS} such pairs signed with Ed25519, sealed into a valid record, stay valid`, TIMEOUT, () => {
    const record = suspensionPairsRecord(PAIRS, participantSignature);
    const pairEvents = record.state.events.filter((event) => event.type === 'suspended' || event.type === 'resumed');
    expect(pairEvents).toHaveLength(2 * PAIRS);
    expect(pairEvents.every((event) => event.actor_signature?.alg === 'Ed25519'), 'every event signed with Ed25519').toBe(true);
    expect(signaturesOf(record).length).toBeLessThanOrEqual(LIMITS.signatures);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, BOUND_MS);
  });
});

describe('12. long text in every signing statement, and resolver answers read once', () => {
  /**
   * Pairs of a suspension and the resumption that lifts it, or suspensions and resumptions by
   * the authority: the shape of known slow inputs.
   */
  const PAIRS = 1_000;
  /**
   * Characters of the long `record_uri`'s path: a known slow input. The record and both versions
   * hold it, and each of the some 2000 signing statements restates it.
   */
  const LONG_PATH = 600_000;
  const SHORT_PATH = 2_000;
  /** Keys without `kid` that a key set answer lists before the real ones. */
  const DECOYS = 1_000;

  /**
   * `PAIRS` Ed25519 pairs as in section 11, with every signature made again over a `record_uri`
   * of a path of `pathLength` characters.
   */
  function longUriRecord(pathLength: number): ConsentRecord {
    const uri = longRecordUri(pathLength);
    const record = withRecordUri(suspensionPairsRecord(PAIRS, participantSignature), uri);
    expect(record.agreements.every((version) => version.agreement['record_uri'] === uri)).toBe(true);
    const pairEvents = record.state.events.filter((event) => event.type === 'suspended' || event.type === 'resumed');
    expect(pairEvents).toHaveLength(2 * PAIRS);
    expect(pairEvents.every((event) => event.actor_signature?.alg === 'Ed25519'), 'every event signed with Ed25519').toBe(true);
    expect(signaturesOf(record).length).toBeLessThanOrEqual(LIMITS.signatures);
    return record;
  }

  it(`a record_uri with a path of ${LONG_PATH} characters, restated by every signing statement of ${PAIRS} Ed25519 pairs: a limit problem, in time`, TIMEOUT, () => {
    const text = JSON.stringify(longUriRecord(LONG_PATH));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expectNoInternal(checked.result);
    expectRulesRan(checked.result);
    expect(rules(checked.result), summary(checked.result)).toContain('limit');
    expect(rules(checked.result).filter((rule) => rule !== 'limit'), summary(checked.result)).toEqual([]);
    expectFaster(checked, 2_000);
  });

  // The shape above stops at a limit, which would hide a builder mistake: a short path stays valid.
  it(`a record_uri with a path of ${SHORT_PATH} characters and ${PAIRS} such pairs, sealed into a valid record, stays valid`, TIMEOUT, () => {
    const text = JSON.stringify(longUriRecord(SHORT_PATH));
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const checked = measure(() => checkRecordText(text));
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
    expectFaster(checked, 2_000);
  });

  /**
   * `authoritySuspensionsRecord(PAIRS)` as text, valid offline, with its authority's `keys_uri`,
   * the number of key set checks that name it, and the key set answer for it: `DECOYS` keys
   * without `kid`, then the keys key-sets.json lists.
   */
  function authoritySigned(): { text: string; keysUri: string; keySetChecks: number; keys: Jwk[] } {
    const record = authoritySuspensionsRecord(PAIRS);
    const keysUri = record.authority.keys_uri;
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const offline = checkRecordText(text);
    expect(offline.problems, formatProblems(offline.problems)).toEqual([]);
    const named = offline.external.flatMap((check) => (check.kind === 'authority_key_set' ? [check.keysUri] : []));
    // Every event's signature and the attestation.
    expect(named).toHaveLength(2 * PAIRS + 1);
    expect(new Set(named)).toEqual(new Set([keysUri]));
    return { text, keysUri, keySetChecks: named.length, keys: [...decoyKeys(DECOYS), ...listedKeys(keysUri)] };
  }

  function expectKeySetsChecked(result: VerifyResult): void {
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.unchecked.filter((entry) => entry.check.kind === 'authority_key_set')).toEqual([]);
  }

  it(`${PAIRS} suspensions and ${PAIRS} resumptions signed by the authority, a key set of ${DECOYS} keys without kid before its own: resolved once, valid, in time`, TIMEOUT, async () => {
    const { text, keysUri, keys } = authoritySigned();
    const asked: string[] = [];
    const keySet = async (uri: string): Promise<JwkSet | undefined> => {
      asked.push(uri);
      return uri === keysUri ? { keys } : undefined;
    };
    const checked = await measureAsync(() => verifyRecord(text, { keySet }));
    expectKeySetsChecked(checked.result);
    expect(asked.filter((uri) => uri === keysUri)).toHaveLength(1);
    expectFaster(checked, 2_500);
  });

  it('the same key set answer with `keys` a getter: read at most once', TIMEOUT, async () => {
    const { text, keysUri, keys } = authoritySigned();
    let reads = 0;
    const answer: JwkSet = {
      get keys(): readonly Jwk[] {
        reads += 1;
        return keys;
      },
    };
    const keySet = async (uri: string): Promise<JwkSet | undefined> => (uri === keysUri ? answer : undefined);
    const { result } = await measureAsync(() => verifyRecord(text, { keySet }));
    expectKeySetsChecked(result);
    expect(reads).toBeLessThanOrEqual(1);
  });

  /**
   * `PAIRS` Ed25519 pairs as in section 11, as text, with its DID URLs and the signatures each
   * binds: many more than `LIMITS.problems`.
   */
  function didBound(): { text: string; bound: Map<string, number> } {
    const record = suspensionPairsRecord(PAIRS, participantSignature);
    const bound = didBindings(record);
    const signed = readExample().state.events.find((event) => event.actor_signature?.signer === PARTICIPANT);
    const participantDid = signed?.actor_signature?.key_binding?.did_url;
    expect(participantDid).toBe('did:example:elin-marsh#key-1');
    // Both versions' signatures by the participant and every event's.
    expect(bound.get(participantDid!)).toBe(2 * PAIRS + 2);
    expect(bound.get(participantDid!)).toBeGreaterThan(10 * LIMITS.problems);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    return { text, bound };
  }

  /**
   * Not valid, and exactly `LIMITS.problems` problems, all R7: one for each signature the DID
   * answer fails, cut at the cap.
   */
  function expectCappedR7(result: VerifyResult): void {
    expectNoInternal(result);
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(rules(result).filter((rule) => rule !== 'R7'), summary(result)).toEqual([]);
    expect(result.problems, summary(result)).toHaveLength(LIMITS.problems);
  }

  it(`${2 * PAIRS + 2} signatures bound by one DID URL that resolves to an RSA key whose n is 1,000,000 characters: resolved once, ${LIMITS.problems} R7 problems, in time`, TIMEOUT, async () => {
    const { text, bound } = didBound();
    const asked: string[] = [];
    const did = async (didUrl: string): Promise<Jwk | undefined> => {
      asked.push(didUrl);
      return LONG_RSA_JWK;
    };
    const checked = await measureAsync(() => verifyRecord(text, { did }));
    expectCappedR7(checked.result);
    for (const didUrl of bound.keys()) expect(asked.filter((url) => url === didUrl), didUrl).toHaveLength(1);
    expect(asked).toHaveLength(bound.size);
    expectFaster(checked, 2_500);
  });

  it(`the same signatures, the DID URL resolving to a fresh Ed25519 key: ${LIMITS.problems} R7 problems`, TIMEOUT, async () => {
    const { text } = didBound();
    const other = freshEd25519Jwk();
    const { result } = await measureAsync(() => verifyRecord(text, { did: async () => other }));
    expectCappedR7(result);
  });

  /**
   * Pairs whose every event names its own DID URL: some 200 URLs, about three times
   * `LIMITS.resolutions`.
   */
  const URL_PAIRS = 100;
  /** What a slow DID resolver waits before each answer. */
  const WAIT_MS = 5;

  type DidCheck = Extract<ExternalCheck, { kind: 'did' }>;

  /**
   * `URL_PAIRS` Ed25519 pairs as in section 11, each event's signature bound by its own DID URL
   * (`didPerEventSignature`), as text, valid offline, with its external checks, its `did` checks
   * and its authority's `keys_uri`.
   */
  function manyDidUrls(): { text: string; external: readonly ExternalCheck[]; didChecks: DidCheck[]; keysUri: string } {
    const record = suspensionPairsRecord(URL_PAIRS, didPerEventSignature);
    const bound = didBindings(record);
    // Every event's own URL, and `#key-1` of both versions' signatures by the participant.
    expect(bound.size).toBe(2 * URL_PAIRS + 1);
    expect(bound.size).toBeGreaterThan(2 * LIMITS.resolutions);
    const text = JSON.stringify(record);
    expect(byteLength(text)).toBeLessThan(LIMITS.textBytes);
    const offline = checkRecordText(text);
    expect(offline.problems, formatProblems(offline.problems)).toEqual([]);
    const didChecks = offline.external.filter((check): check is DidCheck => check.kind === 'did');
    expect(new Set(didChecks.map((check) => check.didUrl))).toEqual(new Set(bound.keys()));
    return { text, external: offline.external, didChecks, keysUri: record.authority.keys_uri };
  }

  /**
   * A DID resolver that answers the participant's own key for every URL, after `waitMs` if any,
   * and the URLs it was asked for.
   */
  function participantDidResolver(waitMs = 0): { asked: string[]; did: (didUrl: string) => Promise<Jwk | undefined> } {
    const asked: string[] = [];
    const key = exampleKey(PARTICIPANT).jwk;
    const did = async (didUrl: string): Promise<Jwk | undefined> => {
      asked.push(didUrl);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return key;
    };
    return { asked, did };
  }

  /**
   * Valid but not complete, and each `did` check run exactly when its URL was asked for: no URL
   * asked for twice, every check of a URL asked for run, and every check of a URL never asked for
   * unchecked, with a reason that names `LIMITS.resolutions`.
   */
  function expectDidsCapped(result: VerifyResult, didChecks: readonly DidCheck[], asked: readonly string[]): void {
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    const askedUrls = new Set(asked);
    expect(askedUrls.size, 'a DID URL asked for twice').toBe(asked.length);
    const uncheckedAt = new Set<string>();
    for (const { check, reason } of result.unchecked) {
      if (check.kind !== 'did') continue;
      expect(askedUrls.has(check.didUrl), `${check.didUrl} asked for, yet unchecked`).toBe(false);
      expect(reason).toContain(String(LIMITS.resolutions));
      uncheckedAt.add(check.at);
    }
    for (const check of didChecks) {
      expect(uncheckedAt.has(check.at), `${check.at} (${check.didUrl}) unchecked`).toBe(!askedUrls.has(check.didUrl));
    }
  }

  it(`${2 * URL_PAIRS + 1} DID URLs, one in each event's signature: ${LIMITS.resolutions} resolved, each once, the others unchecked`, TIMEOUT, async () => {
    const { text, didChecks } = manyDidUrls();
    const { asked, did } = participantDidResolver();
    const { result } = await measureAsync(() => verifyRecord(text, { did }));
    expect(asked).toHaveLength(LIMITS.resolutions);
    expectDidsCapped(result, didChecks, asked);
  });

  // Key sets and DID URLs count together, and key sets come first: the DID URLs cannot crowd out
  // the serving authority's key set, which the attestation names.
  it(`the same, with a key set resolver as well: the serving authority's key set first, then ${LIMITS.resolutions - 1} DID URLs`, TIMEOUT, async () => {
    const { text, didChecks, keysUri } = manyDidUrls();
    const { asked, did } = participantDidResolver();
    const keysAsked: string[] = [];
    const listed = keySetResolver(readKeySets());
    const keySet = async (uri: string): Promise<JwkSet | undefined> => {
      keysAsked.push(uri);
      return listed(uri);
    };
    const { result } = await measureAsync(() => verifyRecord(text, { keySet, did }));
    expect(keysAsked).toEqual([keysUri]);
    expect(asked).toHaveLength(LIMITS.resolutions - 1);
    const attestation = result.unchecked.filter(({ check }) => check.kind === 'authority_key_set' && check.at === '/authority_attestation');
    expect(attestation, 'the attestation key set check unchecked').toEqual([]);
    expectDidsCapped(result, didChecks, asked);
  });

  it('the same, the key set not available: unchecked keeps the order of the offline external list', TIMEOUT, async () => {
    const { text, external } = manyDidUrls();
    const { did } = participantDidResolver();
    const keySet = async (): Promise<JwkSet | undefined> => undefined;
    const { result } = await measureAsync(() => verifyRecord(text, { keySet, did }));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    const keySetChecks = external.filter((check) => check.kind === 'authority_key_set');
    const keySetUnchecked = result.unchecked.filter(({ check }) => check.kind === 'authority_key_set');
    expect(keySetUnchecked).toHaveLength(keySetChecks.length);
    for (const { reason } of keySetUnchecked) expect(reason).toContain('not available');
    expect(result.unchecked.filter(({ check }) => check.kind === 'did').length).toBeGreaterThan(0);

    const index = new Map(external.map((check, i) => [`${check.kind} ${check.at}`, i]));
    expect(index.size).toBe(external.length);
    let previous = -1;
    for (const { check } of result.unchecked) {
      const i = index.get(`${check.kind} ${check.at}`);
      expect(i, `${check.kind} ${check.at} is no external check`).toBeDefined();
      expect(check).toEqual(external[i!]);
      expect(i!, `${check.kind} ${check.at} out of order`).toBeGreaterThan(previous);
      previous = i!;
    }
  });

  /**
   * Each wait takes at least `WAIT_MS`, and some 16 ms on this machine, whose timers tick every
   * 15.6 ms: the `LIMITS.resolutions` waits take about 1 s, the 201 of a verifier without the cap
   * about 3 s. Where timers tick every millisecond, 201 waits take about 1.1 s, within the bound.
   */
  it(`the same DID URLs, each answer after ${WAIT_MS} ms: ${LIMITS.resolutions} waits, in time`, TIMEOUT, async () => {
    const { text, didChecks } = manyDidUrls();
    const { asked, did } = participantDidResolver(WAIT_MS);
    const checked = await measureAsync(() => verifyRecord(text, { did }));
    expect(asked).toHaveLength(LIMITS.resolutions);
    expectDidsCapped(checked.result, didChecks, asked);
    expectFaster(checked, 2_000);
  });

  /**
   * Valid but not complete, and `checks` checks of `kind`, every one unchecked with a reason that
   * starts `resolver failed` (and holds `message`, if given); no reason names `LIMITS.resolutions`,
   * since a call that fails counts once.
   */
  function expectResolverFailed(result: VerifyResult, kind: ExternalCheck['kind'], checks: number, message?: string): void {
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    const failed = result.unchecked.filter(({ check }) => check.kind === kind);
    expect(failed).toHaveLength(checks);
    for (const { reason } of failed) {
      expect(reason.startsWith('resolver failed'), reason).toBe(true);
      if (message !== undefined) expect(reason).toContain(message);
    }
    for (const { reason } of result.unchecked) expect(reason).not.toContain(String(LIMITS.resolutions));
  }

  it(`a key set resolver that throws when called, not rejecting, named by ${2 * PAIRS + 1} authority signatures: called once, every check unchecked as failed`, TIMEOUT, async () => {
    const { text, keysUri, keySetChecks } = authoritySigned();
    expect(keySetChecks).toBeGreaterThan(LIMITS.resolutions);
    const asked: string[] = [];
    const keySet = (uri: string): Promise<JwkSet | undefined> => {
      asked.push(uri);
      throw new Error('boom');
    };
    const { result } = await measureAsync(() => verifyRecord(text, { keySet }));
    expect(asked).toEqual([keysUri]);
    expectResolverFailed(result, 'authority_key_set', keySetChecks, 'boom');
  });

  it(`a DID resolver that throws when called, not rejecting, its one URL named by ${2 * PAIRS + 2} signatures: called once, every check unchecked as failed`, TIMEOUT, async () => {
    const { text, bound } = didBound();
    const asked: string[] = [];
    const did = (didUrl: string): Promise<Jwk | undefined> => {
      asked.push(didUrl);
      throw new Error('boom');
    };
    const { result } = await measureAsync(() => verifyRecord(text, { did }));
    for (const didUrl of bound.keys()) expect(asked.filter((url) => url === didUrl), didUrl).toHaveLength(1);
    expect(asked).toHaveLength(bound.size);
    const checks = [...bound.values()].reduce((sum, n) => sum + n, 0);
    expectResolverFailed(result, 'did', checks);
  });
});
