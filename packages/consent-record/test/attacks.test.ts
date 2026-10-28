/**
 * Regression tests for record shapes built to make the verifier slow, exhaust its memory or
 * flood its output. Each shape is the example record grown in one direction; most are not
 * valid records, and what matters is that the check returns in time, within `LIMITS`, with no
 * `internal` problem. Shape A is re-sealed into a valid record. Shapes C and E are re-sealed
 * too, and break only the rules their shape cannot meet, with fewer problems than
 * `LIMITS.problems`, so that the check runs to their last event.
 */
import { constants, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkRecord, checkRecordText, LIMITS } from '../src/index';
import type { CheckResult, Jwk } from '../src/index';
import {
  attest,
  base64url,
  digest,
  formatProblems,
  jcs,
  readExample,
  signStatement,
  signaturesOf,
  thumbprint,
  type AgreementVersion,
  type ConsentRecord,
  type RecordEvent,
  type Signature,
} from './helpers';

const AUTHORITY = 'https://authority.example';
const OTHER_AUTHORITY = 'https://b.example';
const PARTICIPANT = 'p-elin';
const LIKENESS = 't-likeness-campaign';

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
// The example's last event is recorded at 2026-10-22T16:45:00Z and its as_of is
// 2026-10-27T12:00:00Z. Events recorded at this instant fall in between.
const AFTER_EXAMPLE = Date.parse('2026-10-23T00:00:00Z');

/** Bound on one check of a hostile shape. Before the fixes these took 30 s to 160 s. */
const CHECK_BOUND_MS = 5_000;
/** Bound on refusing text over `LIMITS.textBytes`, which needs no parsing. */
const SIZE_REFUSAL_BOUND_MS = 1_000;
/** Building a shape (signing, digests, key generation, JSON text) takes up to seconds. */
const TIMEOUT = { timeout: 180_000 };

// ---------------------------------------------------------------------------------------
// Small helpers

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** RFC 3339 in UTC, without fractional seconds when they are zero. */
function instant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** `count` strings of about `kib` KiB each, for a grant's `named_works` (no `maxLength`). */
function bigWorks(kib: number, count = 256): string[] {
  const filler = 'w'.repeat(kib * KIB);
  return range(count).map((i) => `${i} ${filler}`);
}

const PLACEHOLDER_DIGEST = 'A'.repeat(43);

// The parts of an agreement these builders change. Everything else stays `unknown`.

interface Party {
  party_id: string;
  identifiers?: unknown[];
  [member: string]: unknown;
}

interface Term {
  term_id: string;
  valid_from?: string;
  valid_until?: string;
  [member: string]: unknown;
}

interface Grant extends Term {
  scope: { named_works?: string[]; [member: string]: unknown };
  compensation: string[];
}

interface Compensation {
  compensation_id: string;
  [member: string]: unknown;
}

interface Agreement {
  version: number;
  parties: Party[];
  terms: Term[];
  compensation: Compensation[];
  [member: string]: unknown;
}

function agreementOf(version: AgreementVersion): Agreement {
  return version.agreement as Agreement;
}

function likenessGrant(version: AgreementVersion): Grant {
  const grant = agreementOf(version).terms.find((term) => term.term_id === LIKENESS);
  if (grant === undefined) throw new Error(`no term ${LIKENESS}`);
  return grant as Grant;
}

function participantSignature(version: AgreementVersion): Signature {
  const signature = version.signatures.find((entry) => entry.signer === PARTICIPANT);
  if (signature === undefined) throw new Error(`no signature by ${PARTICIPANT}`);
  return signature;
}

/** A new event; `chain` numbers it and sets its `prev_digest`. */
function newEvent(fields: Record<string, unknown>): RecordEvent {
  return { seq: 0, ...fields, prev_digest: null } as RecordEvent;
}

/** Appends an event; `chain` numbers it and sets its `prev_digest`. */
function push(record: ConsentRecord, fields: Record<string, unknown>): void {
  record.state.events.push(newEvent(fields));
}

/**
 * Numbers the events 1, 2, ... and chains them (R8), without renewing the attestation: the
 * record is then wrong only where its builder made it so, and in R20.
 */
function chain(record: ConsentRecord): ConsentRecord {
  let previous: string | null = null;
  record.state.events.forEach((event, i) => {
    event.seq = i + 1;
    event.prev_digest = previous;
    previous = digest(event);
  });
  return record;
}

/**
 * Seals a record again after its builder changed it, as `reseal` in regressions.test.ts does:
 * each version's link to the version before (R1), its digest (R2) and its signatures, key
 * bindings kept (R7); the `ref_digest` of every version event whose version the record holds
 * (R9); the event chain (R8); and the attestation (R20). The events these builders add carry
 * no actor signature.
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
  return attest(chain(record));
}

/** True for `versionEvents` of the indexes 0 to `count - 1`, spread evenly; always for the last. */
function isSpread(i: number, versionEvents: number, count: number): boolean {
  return Math.floor(((i + 1) * versionEvents) / count) > Math.floor((i * versionEvents) / count);
}

/** Indexes into `state.events` of the `version_added` events after version 2's own. */
function addedVersionEvents(record: ConsentRecord): number[] {
  const events = record.state.events;
  const own = events.findIndex((event) => event.type === 'version_added' && event['version'] === 2);
  return events.flatMap((event, i) => (i > own && event.type === 'version_added' ? [i] : []));
}

// ---------------------------------------------------------------------------------------
// Checking and the assertions every shape gets

interface Checked {
  readonly result: CheckResult;
  readonly ms: number;
}

/** Runs one check, timing the call alone. A thrown error fails the test. */
function measure(run: () => CheckResult): Checked {
  let result: CheckResult | undefined;
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

const checkText = (text: string): Checked => measure(() => checkRecordText(text));

function rules(result: CheckResult): string[] {
  return result.problems.map((problem) => problem.rule);
}

/** The rules with their counts, and the first problem cut short: for failure messages. */
function summary(result: CheckResult): string {
  const counts = new Map<string, number>();
  for (const rule of rules(result)) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  const listed = [...counts].map(([rule, n]) => `${rule}x${n}`).join(' ') || 'valid';
  const first = result.problems[0];
  return first === undefined ? listed : `${listed}; first: ${first.rule} ${first.message.slice(0, 200)}`;
}

/** What every hostile shape must give: no `internal` problem, and problems within the caps. */
function expectBounded({ result, ms }: Checked, boundMs = CHECK_BOUND_MS): void {
  const about = summary(result);
  expect(rules(result), about).not.toContain('internal');
  expect(result.problems.length, about).toBeLessThanOrEqual(LIMITS.problems);
  const longestAt = Math.max(0, ...result.problems.map((problem) => problem.at.length));
  const longestMessage = Math.max(0, ...result.problems.map((problem) => problem.message.length));
  // A cut text keeps `LIMITS.problemChars` characters and gains "...".
  expect(longestAt, 'longest pointer').toBeLessThanOrEqual(LIMITS.problemChars + 3);
  expect(longestMessage, 'longest message').toBeLessThanOrEqual(LIMITS.problemChars + 3);
  expect(ms, `the check took ${Math.round(ms)} ms (${about})`).toBeLessThan(boundMs);
}

function expectNoLimit(result: CheckResult): void {
  expect(rules(result), summary(result)).not.toContain('limit');
}

function expectLimit(result: CheckResult): void {
  expect(rules(result), summary(result)).toContain('limit');
}

/** Fewer problems than `LIMITS.problems`: the check was not cut short by the cap on problems. */
function expectUnderProblemCap(result: CheckResult): void {
  expect(result.problems.length, summary(result)).toBeLessThan(LIMITS.problems);
}

/**
 * The check ran to the end of the record: fewer problems than `LIMITS.problems`, each of an
 * `allowed` rule or `limit`, and, unless it stopped at a limit, a problem at or inside each
 * event at `offending` (indexes into `state.events`), the last of them included.
 */
function expectRanToTheEnd(result: CheckResult, allowed: readonly string[], offending: readonly number[]): void {
  const about = summary(result);
  expectUnderProblemCap(result);
  for (const rule of new Set(rules(result))) expect([...allowed, 'limit'], about).toContain(rule);
  if (rules(result).includes('limit')) return;
  for (const index of offending) {
    const at = `/state/events/${index}`;
    const found = result.problems.some((problem) => problem.at === at || problem.at.startsWith(`${at}/`));
    expect(found, `no problem at ${at}; ${about}`).toBe(true);
  }
}

/** A shape's JSON text, checked to be under the size limit. */
function textUnderLimit(record: ConsentRecord): string {
  const text = JSON.stringify(record);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(LIMITS.textBytes);
  return text;
}

// ---------------------------------------------------------------------------------------
// Shapes

/**
 * A. `count` corrections by the authority, all recorded at one instant before `as_of`, each
 * explaining event 1. Chained, not attested.
 */
function withCorrections(count: number): ConsentRecord {
  const record = readExample();
  const at = instant(AFTER_EXAMPLE);
  for (let i = 0; i < count; i++) {
    push(record, {
      type: 'correction',
      recorded_at: at,
      effective_at: at,
      actor: AUTHORITY,
      channel: 'system',
      ref_seq: 1,
      note: 'x',
    });
  }
  return chain(record);
}

/**
 * B. `transfers` hand-overs between two authorities, inserted before version 2's event, each
 * with a minimal signature that has the schema's shape but does not verify; then version 2
 * gets `extraSignatures` more copies of the participant's signature, which has a key binding.
 * An even number of hand-overs leaves the example's authority in charge.
 */
function withTransfers(transfers: number, extraSignatures: number): ConsentRecord {
  const record = readExample();
  const events = record.state.events;
  const versionEvent = events.findIndex((event) => event.type === 'version_added');
  const start = Date.parse('2026-10-11T00:00:00Z');
  const kid = record.agreements[0]!.signatures[0]!.kid;
  const handOvers = range(transfers).map((i) => {
    const from = i % 2 === 0 ? AUTHORITY : OTHER_AUTHORITY;
    const to = i % 2 === 0 ? OTHER_AUTHORITY : AUTHORITY;
    return {
      seq: 0,
      type: 'authority_transferred',
      recorded_at: instant(start + i),
      effective_at: instant(start + i),
      actor: from,
      channel: 'system',
      to_authority: to,
      keys_uri: `${from}/k`,
      actor_signature: {
        signer: from,
        signed_at: instant(start),
        alg: 'Ed25519',
        jwk: { kty: 'OKP' },
        kid,
        value: 'a..b',
      },
      prev_digest: null,
    } as unknown as RecordEvent;
  });
  events.splice(versionEvent, 0, ...handOvers);
  const version2 = record.agreements[1]!;
  const participant = participantSignature(version2);
  for (let i = 0; i < extraSignatures; i++) version2.signatures.push(participant);
  return chain(record);
}

/**
 * B. As `withTransfers` without extra signatures, but every hand-over carries a real
 * signature by the example key of its authority over the event (`authority_transfer`), so
 * that each one needs a cryptographic check.
 */
function withSignedTransfers(transfers: number): ConsentRecord {
  const record = withTransfers(transfers, 0);
  let previous: string | null = null;
  record.state.events.forEach((event, i) => {
    event.seq = i + 1;
    event.prev_digest = previous;
    if (event.type === 'authority_transferred') {
      const { actor_signature: placeholder, ...unsigned } = event;
      event.actor_signature = signStatement(
        record,
        'authority_transfer',
        digest(unsigned),
        event.actor,
        placeholder!.signed_at,
      );
    }
    previous = digest(event);
  });
  return record;
}

/** C, D, E: version 2's likeness grant names 256 works of `kib` KiB each. */
function withBigGrant(kib: number): ConsentRecord {
  const record = readExample();
  likenessGrant(record.agreements[1]!).scope.named_works = bigWorks(kib);
  return record;
}

interface TermState {
  term_id: string;
  status: string;
  since: string;
  [member: string]: unknown;
}

/**
 * A suspension of the likeness grant by the authority, which may take effect after it is
 * recorded.
 */
function likenessSuspension(recordedAt: number, effectiveAt: number): Record<string, unknown> {
  return {
    type: 'suspended',
    recorded_at: instant(recordedAt),
    effective_at: instant(effectiveAt),
    actor: AUTHORITY,
    channel: 'system',
    term_ids: [LIKENESS],
  };
}

/**
 * C and E: the likeness grant's `term_states` entry gets its derived status, suspended since
 * `since`, but keeps the example's `effective`. The derived one would name the 256 long works
 * again and put the text over `LIMITS.textBytes`, so R17 finds that one difference.
 */
function markLikenessSuspended(record: ConsentRecord, since: number): void {
  const state = (record.state['term_states'] as TermState[]).find((entry) => entry.term_id === LIKENESS);
  if (state === undefined) throw new Error(`no term state for ${LIKENESS}`);
  state.status = 'suspended';
  state.since = instant(since);
}

/**
 * C. `count` events by the authority on version 2's likeness grant, recorded at one instant
 * between version 2's event and the example's narrowing and in effect 1 ms apart, so that version
 * 2 restates no withdrawn term when they take effect (R5). `versionEvents` of them, spread
 * evenly and the last included, are more `version_added` events for version 2 with the
 * `ref_digest` R9 asks for; the others suspend the grant. The first suspends it; each later one
 * changes no state, like a repeated version event, and is valid on a suspended grant (R13).
 * Version 2 is sealed again.
 *
 * R9 allows exactly one version event per version, so each added version event is an R9 problem
 * whatever it holds, and 3000 of them would stop the check at `LIMITS.problems`. Nor can a record
 * carry 3000 valid version events here: each would need a version of its own, restating the
 * 2.5 MiB grant. So only `versionEvents` events offend and the others are valid.
 */
function withRepeatedVersionEvents(count: number, versionEvents: number, kib: number): ConsentRecord {
  const record = withBigGrant(kib);
  const events = record.state.events;
  const own = events.findIndex((event) => event.type === 'version_added' && event['version'] === 2);
  const at = Date.parse('2026-10-13T00:00:00Z');
  expect(at).toBeGreaterThan(Date.parse(events[own]!.recorded_at));
  expect(at + count).toBeLessThan(Date.parse(events[own + 1]!.recorded_at));
  const added = range(count).map((i) =>
    newEvent(
      isSpread(i, versionEvents, count)
        ? {
            type: 'version_added',
            recorded_at: instant(at),
            effective_at: instant(at + i),
            actor: AUTHORITY,
            channel: 'system',
            version: 2,
            ref_digest: PLACEHOLDER_DIGEST,
          }
        : likenessSuspension(at, at + i),
    ),
  );
  expect(added[0]!.type).toBe('suspended');
  events.splice(own + 1, 0, ...added);
  markLikenessSuspended(record, at);
  return reseal(record);
}

/**
 * D. `count` narrowings of the likeness grant by the participant, each adding one prohibited
 * context.
 */
function withContextNarrowings(count: number, kib: number): ConsentRecord {
  const record = withBigGrant(kib);
  for (let i = 0; i < count; i++) {
    const at = instant(AFTER_EXAMPLE + i);
    push(record, {
      type: 'narrowed',
      recorded_at: at,
      received_at: at,
      effective_at: at,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: [LIKENESS],
      narrowing: { add_prohibited_contexts: [`https://c.example/${i}`] },
    });
  }
  return chain(record);
}

/**
 * E. A suspension of version 2's likeness grant by the authority in effect before `as_of`, then
 * `count` events by the authority in effect after `as_of`, 1 s apart; all are recorded at one
 * instant after the example's last event. `versionEvents` of the later ones, spread evenly and
 * the last included, are `version_added` events for version 99, which does not exist; the others
 * suspend the grant again, which changes no state and is valid on a suspended grant (R13). The
 * derived state is the same at each of these instants, so the next change stays the grant's end
 * (R18). Version 2 is sealed again.
 *
 * R9 makes each event for version 99 a problem whatever it holds: it is out of version order and
 * names a version the record does not hold, so no `agreements` item gives the digest R9 asks
 * for, and its `ref_digest` stays a placeholder. 3000 of them would stop the check at
 * `LIMITS.problems`, so only `versionEvents` events offend and the others are valid.
 */
function withMissingVersionEvents(count: number, versionEvents: number, kib: number): ConsentRecord {
  const record = withBigGrant(kib);
  const later = Date.parse('2026-11-01T00:00:00Z');
  expect(later).toBeGreaterThan(Date.parse(record.state.as_of));
  push(record, likenessSuspension(AFTER_EXAMPLE, AFTER_EXAMPLE));
  for (let i = 0; i < count; i++) {
    push(
      record,
      isSpread(i, versionEvents, count)
        ? {
            type: 'version_added',
            recorded_at: instant(AFTER_EXAMPLE),
            effective_at: instant(later + i * SECOND),
            actor: AUTHORITY,
            channel: 'system',
            version: 99,
            ref_digest: PLACEHOLDER_DIGEST,
          }
        : likenessSuspension(AFTER_EXAMPLE, later + i * SECOND),
    );
  }
  markLikenessSuspended(record, AFTER_EXAMPLE);
  return reseal(record);
}

/**
 * F. In both versions the likeness grant names 64 compensation items and 256 works of `kib`
 * KiB.
 */
function withCompensatedGrant(kib: number): ConsentRecord {
  const record = readExample();
  for (const version of record.agreements) {
    const agreement = agreementOf(version);
    const grant = likenessGrant(version);
    grant.scope.named_works = bigWorks(kib);
    const first = agreement.compensation.find((item) => item.compensation_id === grant.compensation[0]);
    if (first === undefined) throw new Error('no compensation item for the likeness grant');
    while (grant.compensation.length < 64) {
      const id = `c-x${grant.compensation.length}`;
      agreement.compensation.push({ ...structuredClone(first), compensation_id: id });
      grant.compensation.push(id);
    }
  }
  return chain(record);
}

type RsaKey = 'generated 4096-bit' | { readonly modulusBits: number; readonly exponentBits: number };

/**
 * G. A PS256 signature by the participant over version 1's agreement statement. With a
 * generated key it verifies; with a random modulus and an all-ones exponent of the given
 * sizes (outside what R7 allows) it is random bytes that a verifier would have to run the
 * full modular exponentiation on.
 */
function ps256Signature(record: ConsentRecord, key: RsaKey): Signature {
  const version1 = record.agreements[0]!;
  const base = participantSignature(version1);
  let jwk: Jwk;
  let modulusBytes: number;
  let privateKey: KeyObject | undefined;
  if (key === 'generated 4096-bit') {
    const pair = generateKeyPairSync('rsa', { modulusLength: 4096 });
    jwk = pair.publicKey.export({ format: 'jwk' }) as Jwk;
    privateKey = pair.privateKey;
    modulusBytes = 512;
  } else {
    const n = randomBytes(key.modulusBits / 8);
    n[0] = (n[0] ?? 0) | 0x80;
    n[n.length - 1] = (n[n.length - 1] ?? 0) | 1;
    const e = Buffer.alloc(key.exponentBits / 8, 0xff);
    jwk = { kty: 'RSA', n: base64url(n), e: base64url(e) } as Jwk;
    modulusBytes = n.length;
  }
  const kid = thumbprint(jwk);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'PS256', b64: false, crit: ['b64'], kid }), 'utf8'));
  const payload = jcs({
    profile: record.profile,
    record_uri: record.record_uri,
    statement: 'agreement',
    digest: version1.agreement_digest.value,
    signer: PARTICIPANT,
    signed_at: base.signed_at,
  });
  let value: Buffer;
  if (privateKey === undefined) {
    value = randomBytes(modulusBytes);
    value[0] = 0x01;
  } else {
    value = sign('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
  }
  return { ...structuredClone(base), alg: 'PS256', jwk, kid, value: `${header}..${base64url(value)}` };
}

/** G. Version 1 gets as many copies of one PS256 signature as fill about `bytes` of text. */
function withRsaSignatures(key: RsaKey, bytes = 8 * MIB): ConsentRecord {
  const record = readExample();
  const signature = ps256Signature(record, key);
  const count = Math.floor(bytes / (JSON.stringify(signature).length + 1));
  const signatures = record.agreements[0]!.signatures;
  for (let i = 0; i < count; i++) signatures.push(signature);
  return chain(record);
}

/**
 * H. Text, not a record: `depth` objects nested in one another, each under a member name of
 * `nameKiB` KiB, around an array of `count` lone surrogates. Every R0 problem's pointer would
 * be `depth * nameKiB` KiB long, and there are `count` of them.
 */
function pointerFloodText(depth = 40, nameKiB = 64, count = 100_000): string {
  let open = '';
  let close = '';
  for (let level = 0; level < depth; level++) {
    open += `{"${String(level).padEnd(nameKiB * KIB, 'n')}":`;
    close += '}';
  }
  const bad = Array.from({ length: count }, () => '"\\ud800"').join(',');
  return `{"x":${open}[${bad}]${close}}`;
}

/**
 * K. `versionEvents` events for version 1 that take effect in a year, then `instructions`
 * suspensions by the participant, each naming 256 term ids that no version holds.
 */
function withLaterSources(versionEvents: number, instructions: number): ConsentRecord {
  const record = readExample();
  for (let i = 0; i < versionEvents; i++) {
    push(record, {
      type: 'version_added',
      recorded_at: instant(AFTER_EXAMPLE),
      effective_at: instant(AFTER_EXAMPLE + 365 * DAY + i),
      actor: AUTHORITY,
      channel: 'system',
      version: 1,
      ref_digest: PLACEHOLDER_DIGEST,
    });
  }
  const termIds = range(256).map((i) => `t-u${i}`);
  for (let i = 0; i < instructions; i++) {
    const at = instant(AFTER_EXAMPLE + i);
    push(record, {
      type: 'suspended',
      recorded_at: at,
      received_at: at,
      effective_at: at,
      actor: PARTICIPANT,
      channel: 'authority_portal',
      term_ids: termIds,
    });
  }
  return chain(record);
}

/**
 * L. In version 1 the participant lists `identifiers` more DIDs and comes after `parties`
 * more parties, and signs `signatures` more times.
 */
function withLongScans(signatures: number, identifiers: number, parties: number): ConsentRecord {
  const record = readExample();
  const version1 = record.agreements[0]!;
  const agreement = agreementOf(version1);
  const participant = agreement.parties.find((party) => party.party_id === PARTICIPANT);
  if (participant === undefined) throw new Error(`no party ${PARTICIPANT}`);
  participant.identifiers = [
    ...(participant.identifiers ?? []),
    ...range(identifiers).map((i) => ({ scheme: 'did', value: `did:example:x${i}` })),
  ];
  const others = agreement.parties.filter((party) => party !== participant);
  agreement.parties = [
    ...others,
    ...range(parties).map((i) => ({ party_id: `q${i}`, roles: ['payee'], type: 'organization' })),
    participant,
  ];
  const signature = participantSignature(version1);
  for (let i = 0; i < signatures; i++) version1.signatures.push(signature);
  return chain(record);
}

/** M. Version 1 gets `count` more compensation items. */
function withCompensationItems(count: number): ConsentRecord {
  const record = readExample();
  const compensation = agreementOf(record.agreements[0]!).compensation;
  for (let i = 0; i < count; i++) compensation.push({ compensation_id: `c${i}`, model: 'unpaid', description: 'x' });
  return chain(record);
}

/**
 * N. `count` more versions with no version event, copies of version 2 signed by one signer,
 * each moving every term's `valid_from` and `valid_until` to fresh instants after `as_of`.
 */
function withUnrecordedVersions(count: number): ConsentRecord {
  const record = readExample();
  const base = record.agreements[1]!;
  const start = Date.parse('2026-11-01T00:00:00Z');
  for (let k = 3; k < 3 + count; k++) {
    const version = structuredClone(base);
    const agreement = agreementOf(version);
    agreement.version = k;
    version.signatures = version.signatures.slice(0, 1);
    agreement.terms.forEach((term, j) => {
      term.valid_from = instant(start + (k * 8 + 2 * j) * SECOND);
      term.valid_until = instant(start + 10_000_000_000 + (k * 8 + 2 * j + 1) * SECOND);
    });
    record.agreements.push(version);
  }
  return chain(record);
}

/** Version 1 gets `count` copies of the participant's signature with a broken value. */
function withBrokenSignatures(count: number): ConsentRecord {
  const record = readExample();
  const version1 = record.agreements[0]!;
  const participant = participantSignature(version1);
  const broken: Signature = { ...participant, value: `${participant.value.slice(0, -4)}AAAA` };
  for (let i = 0; i < count; i++) version1.signatures.push(broken);
  return record;
}

// ---------------------------------------------------------------------------------------
// Tests

describe('A. many corrections', () => {
  // A correction changes no state (spec/README.md, "Events"), so the example's term_states
  // and freshness stay right; chaining the events and renewing the attestation re-seals it.
  it.each([5_000, 15_000])('a valid record with %i corrections before as_of stays valid', TIMEOUT, (count) => {
    const record = attest(withCorrections(count));
    expect(record.state.events).toHaveLength(7 + count);
    const checked = checkText(JSON.stringify(record));
    expectBounded(checked);
    expect(checked.result.problems, formatProblems(checked.result.problems)).toEqual([]);
  });

  it('15000 corrections appended without a new attestation fail R20 only, with no limit', TIMEOUT, () => {
    const checked = checkText(JSON.stringify(withCorrections(15_000)));
    expectBounded(checked);
    expectNoLimit(checked.result);
    expect(checked.result.problems.length, summary(checked.result)).toBeGreaterThan(0);
    expect(new Set(rules(checked.result)), summary(checked.result)).toEqual(new Set(['R20']));
  });
});

describe('B. authority hand-overs', () => {
  // The hand-overs' placeholder signatures fail on their header, before any cryptographic
  // check; the signatures left to verify stay within LIMITS.signatures, while every
  // key-bound signature on version 2 is judged against the 2000 hand-overs before it.
  it('2000 hand-overs before version 2 and 4500 more key-bound signatures on it, within the signature limit', TIMEOUT, () => {
    const record = withTransfers(2_000, 4_500);
    const toVerify = signaturesOf(record).filter(({ signature }) => signature.value !== 'a..b');
    expect(toVerify.length).toBeLessThanOrEqual(LIMITS.signatures);
    const checked = checkText(JSON.stringify(record));
    expectBounded(checked);
    expectNoLimit(checked.result);
  });

  it('12000 hand-overs before version 2 and 12000 more key-bound signatures on it exceed the signature limit', TIMEOUT, () => {
    const record = withTransfers(12_000, 12_000);
    expect(signaturesOf(record).length).toBeGreaterThan(LIMITS.signatures);
    const checked = checkText(JSON.stringify(record));
    expectBounded(checked);
    expectLimit(checked.result);
  });

  it('12000 hand-overs, each with a real signature, exceed the signature limit', TIMEOUT, () => {
    const record = withSignedTransfers(12_000);
    expect(signaturesOf(record).length).toBeGreaterThan(LIMITS.signatures);
    const checked = checkText(JSON.stringify(record));
    expectBounded(checked);
    expectLimit(checked.result);
  });
});

// Sized to stay under LIMITS.textBytes, so that the rules run on them, and with fewer problems
// than LIMITS.problems, so that the check is not cut short at the cap.
describe('C to E. a grant with 256 long named works', () => {
  // The added version events break R9 (one version event per version); R17 finds the
  // likeness grant's `effective`, which the text has no room to restate (`markLikenessSuspended`).
  it('C. 3000 events for version 2 at one instant, 90 of them more version_added events, named works 256 x 10 KiB', TIMEOUT, () => {
    const record = withRepeatedVersionEvents(3_000, 90, 10);
    const offending = addedVersionEvents(record);
    expect(offending).toHaveLength(90);
    // The last added event is a version event: only the example's events 6 and 7 follow it.
    expect(record.state.events.slice(offending.at(-1)! + 1).map((event) => event.type)).toEqual(['narrowed', 'withdrawn']);
    const checked = checkText(textUnderLimit(record));
    expectBounded(checked);
    // `expectRanToTheEnd` stops looking at the offending events once a limit appears.
    expectNoLimit(checked.result);
    expectRanToTheEnd(checked.result, ['R9', 'R17'], offending);
  });

  // A limit is allowed, not required: the grant need not be compared with its text at each
  // narrowing.
  it.each([10, 1])('D. 3000 narrowings, each adding a prohibited context, named works 256 x %i KiB', TIMEOUT, (kib) => {
    const checked = checkText(textUnderLimit(withContextNarrowings(3_000, kib)));
    expectBounded(checked);
    expectUnderProblemCap(checked.result);
  });

  // As for C: the events for version 99 break R9, and R17 finds the likeness grant's `effective`.
  it('E. 3000 events after as_of, 45 of them version_added events for a missing version 99, named works 256 x 10 KiB', TIMEOUT, () => {
    const record = withMissingVersionEvents(3_000, 45, 10);
    const offending = addedVersionEvents(record);
    expect(offending).toHaveLength(45);
    expect(offending.at(-1)).toBe(record.state.events.length - 1);
    const checked = checkText(textUnderLimit(record));
    expectBounded(checked);
    expectNoLimit(checked.result);
    expectRanToTheEnd(checked.result, ['R9', 'R17'], offending);
  });
});

describe('F. a grant naming 64 compensation items in two versions', () => {
  it('named works 256 x 16 KiB', TIMEOUT, () => {
    expectBounded(checkText(JSON.stringify(withCompensatedGrant(16))));
  });

  it('named works 256 x 56 KiB: text over the size limit, refused at once', TIMEOUT, () => {
    const record = withCompensatedGrant(56);
    const text = JSON.stringify(record);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(LIMITS.textBytes);
    for (const checked of [checkText(text), measure(() => checkRecord(record))]) {
      expectBounded(checked, SIZE_REFUSAL_BOUND_MS);
      expectLimit(checked.result);
    }
  });
});

describe('G. many PS256 signatures on one version', () => {
  it('about 4600 copies of a valid signature with a generated 4096-bit key', TIMEOUT, () => {
    const record = withRsaSignatures('generated 4096-bit');
    const count = record.agreements[0]!.signatures.length;
    expect(count).toBeGreaterThan(4_400);
    expect(count).toBeLessThan(4_800);
    expectBounded(checkText(JSON.stringify(record)));
  });

  it.each([
    { modulusBits: 3072, exponentBits: 256 },
    { modulusBits: 16384, exponentBits: 64 },
  ])('8 MiB of signatures with a random $modulusBits-bit modulus and a $exponentBits-bit exponent', TIMEOUT, (key) => {
    expectBounded(checkText(JSON.stringify(withRsaSignatures(key))));
  });
});

describe('H. long pointers', () => {
  it('100000 lone surrogates under 40 member names of 64 KiB: exactly LIMITS.problems problems, each cut', TIMEOUT, () => {
    const checked = checkText(pointerFloodText());
    expectBounded(checked);
    expect(checked.result.problems).toHaveLength(LIMITS.problems);
  });
});

describe('K. instructions naming terms only a later version could hold', () => {
  it.each([
    [2_000, 1_000],
    [2_500, 4_000],
  ])('%i version events and %i instructions on 256 unknown term ids', TIMEOUT, (versionEvents, instructions) => {
    expectBounded(checkText(JSON.stringify(withLaterSources(versionEvents, instructions))));
  });
});

describe('L and M. long lists scanned per item', () => {
  it('L. 4000 signatures by a participant with 40000 identifiers among 40000 parties', TIMEOUT, () => {
    expectBounded(checkText(JSON.stringify(withLongScans(4_000, 40_000, 40_000))));
  });

  it.each([40_000, 160_000])('M. %i compensation items', TIMEOUT, (count) => {
    expectBounded(checkText(JSON.stringify(withCompensationItems(count))));
  });
});

describe('N. versions that never take effect', () => {
  it.each([200, 1_600])('%i unrecorded versions, each moving every term', TIMEOUT, (count) => {
    expectBounded(checkText(JSON.stringify(withUnrecordedVersions(count))));
  });
});

describe('problem cap', () => {
  it('R0 on the text: 200000 lone surrogates give exactly LIMITS.problems problems', TIMEOUT, () => {
    const checked = checkText(pointerFloodText(1, 1, 200_000));
    expectBounded(checked);
    expect(checked.result.problems).toHaveLength(LIMITS.problems);
    expect(new Set(rules(checked.result))).toEqual(new Set(['R0']));
  });

  it('R0 on the values: 300 lone surrogates in a disclosure give exactly LIMITS.problems problems', TIMEOUT, () => {
    const record = readExample();
    record.disclosures![digest('problem cap')] = { salt: 'cHJvYmxlbS1jYXAtc2FsdA', value: range(300).map(() => '\ud800') };
    const checked = measure(() => checkRecord(record));
    expectBounded(checked);
    expect(checked.result.problems).toHaveLength(LIMITS.problems);
  });

  it('rule checks: 300 broken signatures give exactly LIMITS.problems problems', TIMEOUT, () => {
    const checked = checkText(JSON.stringify(withBrokenSignatures(300)));
    expectBounded(checked);
    expect(checked.result.problems, summary(checked.result)).toHaveLength(LIMITS.problems);
  });
});
