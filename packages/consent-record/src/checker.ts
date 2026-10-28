/**
 * The validation rules R1–R20 of spec/README.md ("Validation rules beyond JSON Schema") on a
 * record that already passed R0 and the JSON Schema. A rule about the state or the version in
 * force at an event's time judges the event against the events before it in `seq` order
 * (D21). Instants compare as instants.
 *
 * The checks run in a fixed order: versions (R1–R5), signatures (R6, R7), events (R5, R8–R16),
 * payments and bindings (R15, R16), term states (R17, R18), disclosures (R19) and the
 * attestation (R20). One defect can break several rules, and each is reported.
 */
import {
  canonEffective,
  countAtOrBelow,
  countBelow,
  Derivation,
  isWorld,
  valuesIn,
  type DerivedState,
  type VersionEffect,
} from './derive';
import { digestOf, instant, iso, plusYears, sha256 } from './encoding';
import { pointerToken } from './ijson';
import { canonicalize } from './jcs';
import { algMatchesJwk, verifySignature, type SigningStatement } from './jws';
import { clip, LimitError, LIMITS, signatureSteps, statementSteps, Work } from './limits';
import {
  isAuthority,
  isInstruction,
  isPaymentEvent,
  isVersionEvent,
  type Agreement,
  type AssetBinding,
  type Compensation,
  type ConsentRecord,
  type Effective,
  type Grant,
  type InstructionEvent,
  type Narrowing,
  type Party,
  type Payment,
  type PaymentEvent,
  type RecordEvent,
  type ResumedEvent,
  type Role,
  type Signature,
  type Status,
  type SuspendedEvent,
  type Term,
  type TermState,
  type VersionEvent,
} from './record';
import type { Problem, RuleId } from './types';

/**
 * The `profile` of every signing statement. The schema fixes the record's `profile` to this
 * value and R1 requires each version to name the record's, so statements need not read it.
 */
const PROFILE = 'https://grantmark.example/spec/consent-authority-record/0.2.0';

/** The states in which an instruction can still act on a grant (R13). */
const LIVE: ReadonlySet<Status> = new Set<Status>(['in_force', 'not_yet_valid', 'suspended']);

/** The DID of a `did_url`: the part before any `/`, `?` or `#`. */
const DID = /^did:[a-z0-9]+:[^/?#\s]+/;

/**
 * Top-level MIME type → the asset media types it can carry (R16). Other top-level types are not
 * checked.
 */
const MIME_CATEGORIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['image', new Set(['image'])],
  ['video', new Set(['video'])],
  ['audio', new Set(['audio'])],
  ['model', new Set(['3d'])],
  ['text', new Set(['text', 'interactive'])],
]);

/** The schema's `money` and `percent` patterns, for disclosed values (R19). */
const MONEY_VALUE = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const PERCENT = /^(100(\.0{1,4})?|[0-9]{1,2}(\.[0-9]{1,4})?)$/;

/** The members of an event that an `event_instruction` statement covers. */
const INSTRUCTION_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'actor',
  'on_behalf_of',
  'effective_at',
  'term_ids',
  'narrowing',
  'version',
  'ref',
  'ref_seq',
  'ref_digest',
]);

/**
 * R1–R20 on a record that passed R0 and the JSON Schema (formats asserted). Returns the
 * problems found, at most `LIMITS.problems`; empty when the record is valid. Throws a
 * `LimitError` when the checks would cost more than `LIMITS` allows.
 */
export function checkRules(record: unknown): Problem[] {
  return new Checker(record as ConsentRecord).run();
}

/** The previous version of version 1: in version 1 every item and declaration is new (R6). */
type Previous = Pick<Agreement, 'parties' | 'terms' | 'compensation' | 'asset_rights'> &
  Partial<Pick<Agreement, 'biometric_identifiers' | 'end_of_use'>>;

const NO_VERSION: Previous = { parties: [], terms: [], compensation: [], asset_rights: [] };

/** A recorded payment's compensation item, as it stood at `paid_at` (R15). */
interface PaymentItem {
  readonly version: number | undefined;
  readonly item: Compensation | undefined;
}

/**
 * Where a key binding is judged: how many events come before the one that records the
 * signature, and its `recorded_at`.
 */
interface Recording {
  readonly length: number;
  readonly recorded: number;
}

class Checker {
  private readonly r: ConsentRecord;
  /** The steps of this check, shared with the derivation. */
  private readonly work = new Work();
  private readonly d: Derivation;
  private readonly versions: readonly Agreement[];
  private readonly events: readonly RecordEvent[];
  private readonly payments: ReadonlyMap<string, Payment>;
  private readonly bindings: ReadonlyMap<string, AssetBinding>;
  /** Index of each binding in `state.asset_bindings`, for pointers. */
  private readonly bindingIndex: ReadonlyMap<string, number>;
  private readonly problems: Problem[] = [];
  /** The participant's party_id (R5); with several, the first in code point order. */
  private participant = '';
  /** kid → the first signer that used it (R6). */
  private readonly keyOwners = new Map<string, string>();
  /** Signatures verified so far, against `LIMITS.signatures`. */
  private signaturesVerified = 0;
  // Per object of the record, made once: each is read for many events or signatures.
  private readonly participants = new WeakMap<Agreement, string>();
  private readonly partyDids = new WeakMap<Party, ReadonlySet<string>>();
  private readonly partyCertificates = new WeakMap<Party, { readonly pinned: ReadonlySet<string>; readonly named: boolean }>();
  private readonly compensations = new WeakMap<Previous, ReadonlyMap<string, Compensation>>();
  private readonly grantsByCompensation = new WeakMap<Previous, ReadonlyMap<string, readonly Grant[]>>();
  private readonly declarations = new WeakMap<Previous, WeakMap<Term, string>>();
  private readonly digests = new WeakMap<object, string>();
  // Indexes of `events`, so that judging an event against the events before it (a prefix of
  // `events`, by its length) does not scan that prefix again for every event.
  /** version → the position of its first version event. */
  private readonly versionEventAt = new Map<number, number>();
  /** seq → the positions of the suspensions with that seq, ascending. */
  private readonly suspensionsBySeq = new Map<number, number[]>();
  /** `${ref_seq} ${tid}` → the position of the first resumption that lifts it. */
  private readonly firstResumption = new Map<string, number>();
  /**
   * tid → the positions of the narrowings of it with an `end_earlier`, and the earliest such
   * end up to each.
   */
  private readonly endsEarlier = new Map<string, { readonly positions: number[]; readonly earliest: number[] }>();
  /**
   * The hand-overs (`authority_transferred`) in record order: positions, `recorded_at` and new
   * authority.
   */
  private readonly handOvers = { positions: [] as number[], recorded: [] as number[], to: [] as string[] };
  /** Whether the hand-overs are recorded in time order, as R8 requires of all events. */
  private handOversInOrder = true;

  constructor(record: ConsentRecord) {
    this.r = record;
    this.versions = record.agreements.map((item) => item.agreement);
    this.events = record.state.events;
    this.d = new Derivation(this.versions, this.events, this.work);
    this.payments = new Map((record.state.payments ?? []).map((p) => [p.payment_id, p]));
    const bindings = record.state.asset_bindings ?? [];
    this.bindings = new Map(bindings.map((b) => [b.binding_id, b]));
    this.bindingIndex = new Map(bindings.map((b, i) => [b.binding_id, i]));
    this.work.spend(this.events.length);
    this.events.forEach((e, i) => {
      if (isVersionEvent(e) && !this.versionEventAt.has(e.version)) this.versionEventAt.set(e.version, i);
      if (e.type === 'suspended') {
        const list = this.suspensionsBySeq.get(e.seq);
        if (list === undefined) this.suspensionsBySeq.set(e.seq, [i]);
        else list.push(i);
      }
      if (e.type === 'authority_transferred') {
        const recorded = instant(e.recorded_at);
        if (recorded < (this.handOvers.recorded.at(-1) ?? -Infinity)) this.handOversInOrder = false;
        this.handOvers.positions.push(i);
        this.handOvers.recorded.push(recorded);
        this.handOvers.to.push(e.to_authority);
      }
      if (e.type === 'resumed') {
        this.work.spend(e.term_ids.length);
        for (const tid of e.term_ids) {
          const key = `${e.ref_seq} ${tid}`;
          if (!this.firstResumption.has(key)) this.firstResumption.set(key, i);
        }
      }
      if (e.type === 'narrowed' && e.narrowing.end_earlier !== undefined) {
        const end = instant(e.narrowing.end_earlier);
        this.work.spend(e.term_ids.length);
        for (const tid of new Set(e.term_ids)) {
          let entry = this.endsEarlier.get(tid);
          if (entry === undefined) this.endsEarlier.set(tid, (entry = { positions: [], earliest: [] }));
          entry.earliest.push(Math.min(end, entry.earliest.at(-1) ?? Infinity));
          entry.positions.push(i);
        }
      }
    });
  }

  run(): Problem[] {
    try {
      this.checkVersions();
      this.checkSignatures();
      this.checkEvents();
      this.checkPaymentsAndBindings();
      this.checkTermStates();
      this.checkDisclosures();
      this.checkAttestation();
    } catch (error) {
      if (!(error instanceof EnoughProblems)) throw error;
    }
    return this.problems;
  }

  private err(rule: RuleId, at: string, message: string): void {
    this.problems.push({ rule, at: clip(at), message: clip(message) });
    // The record is invalid already; the remaining checks would only make the list longer.
    if (this.problems.length >= LIMITS.problems) throw new EnoughProblems();
  }

  /** `verifySignature`, counted against `LIMITS.signatures` and the steps. */
  private verify(sig: Signature, stmt: SigningStatement): string[] {
    this.signaturesVerified += 1;
    if (this.signaturesVerified > LIMITS.signatures) {
      throw new LimitError(`the record has more than ${LIMITS.signatures} signatures to verify`);
    }
    this.work.spend(signatureSteps(sig.alg) + statementSteps(stmt));
    return verifySignature(sig, stmt);
  }

  /** `canonicalize`, counted against the steps. */
  private canon(value: unknown): string {
    const text = canonicalize(value);
    this.work.spendChars(text.length);
    return text;
  }

  /** `digestOf` an object of the record, made once per object and counted against the steps. */
  private digestOnce(value: object): string {
    let digest = this.digests.get(value);
    if (digest === undefined) {
      digest = sha256(this.canon(value));
      this.digests.set(value, digest);
    }
    return digest;
  }

  private statement(kind: SigningStatement['statement'], digest: string, signer: string, signedAt: string): SigningStatement {
    return { profile: PROFILE, record_uri: this.r.record_uri, statement: kind, digest, signer, signed_at: signedAt };
  }

  // ---------- helpers over versions ----------

  private hasRole(v: Agreement, pid: string | undefined, role: Role): boolean {
    const p = pid === undefined ? undefined : this.d.parties(v).get(pid);
    return p !== undefined && p.roles.includes(role);
  }

  private participantOf(v: Agreement): string {
    let pid = this.participants.get(v);
    if (pid === undefined) {
      this.work.spend(v.parties.length);
      const p = v.parties.find((x) => x.roles.includes('participant'));
      // The schema requires exactly one participant in every version.
      if (p === undefined) throw new Error(`version ${v.version} has no participant`);
      pid = p.party_id;
      this.participants.set(v, pid);
    }
    return pid;
  }

  /** The DIDs a party lists in clear: in its identity bindings and its identifiers (R6). */
  private didsOf(party: Party): ReadonlySet<string> {
    let dids = this.partyDids.get(party);
    if (dids === undefined) {
      const bindings = party.identity_binding ?? [];
      const identifiers = party.identifiers ?? [];
      this.work.spend(bindings.length + identifiers.length);
      dids = new Set([
        ...bindings.flatMap((b) => (b.method === 'did' ? [b.value] : [])),
        ...identifiers.flatMap((i) => (i.scheme === 'did' && typeof i.value === 'string' ? [i.value] : [])),
      ]);
      this.partyDids.set(party, dids);
    }
    return dids;
  }

  /**
   * What a party lists in clear that a certificate can match: certificate digests, and whether
   * a domain or LEI (R6).
   */
  private certificatesOf(party: Party): { readonly pinned: ReadonlySet<string>; readonly named: boolean } {
    let found = this.partyCertificates.get(party);
    if (found === undefined) {
      const identifiers = party.identifiers ?? [];
      this.work.spend(identifiers.length);
      const clear = identifiers.flatMap((i) => (typeof i.value === 'string' ? [{ scheme: i.scheme, value: i.value }] : []));
      found = {
        pinned: new Set(clear.filter((i) => i.scheme === 'x509_sha256').map((i) => i.value)),
        named: clear.some((i) => i.scheme === 'domain' || i.scheme === 'lei'),
      };
      this.partyCertificates.set(party, found);
    }
    return found;
  }

  /** The first version event for version `n`, with its index in `events`. */
  private versionEvent(n: number): { readonly index: number; readonly event: VersionEvent } | undefined {
    const index = this.versionEventAt.get(n);
    const event = index === undefined ? undefined : this.events[index];
    return index !== undefined && event !== undefined && isVersionEvent(event) ? { index, event } : undefined;
  }

  // ---------- R1–R5: versions ----------

  private checkVersions(): void {
    const r = this.r;
    let prevDigest: string | undefined;
    const participants = new Set<string>();
    r.agreements.forEach((item, i) => {
      const v = item.agreement;
      const n = i + 1;
      const at = `/agreements/${i}/agreement`;
      if (v.version !== n) this.err('R1', `${at}/version`, `agreements[${i}] has version ${v.version}, expected ${n}`);
      if (v.profile !== r.profile || v.record_uri !== r.record_uri) {
        this.err('R1', at, `version ${n} names another profile or record_uri`);
      }
      if (n > 1 && v.previous_version_digest !== prevDigest) {
        this.err(
          'R1',
          `${at}/previous_version_digest`,
          `version ${n} previous_version_digest does not match version ${n - 1}`,
        );
      }
      if (item.agreement_digest.value !== this.digestOnce(v)) {
        this.err(
          'R2',
          `/agreements/${i}/agreement_digest/value`,
          `version ${n} agreement_digest does not match the agreement`,
        );
      }
      prevDigest = item.agreement_digest.value;
      participants.add(this.participantOf(v));
      this.checkVersionRefs(v, n, at);
    });
    const sortedParticipants = [...participants].sort(byCodePoint);
    if (sortedParticipants.length !== 1) {
      this.err('R5', '/agreements', `participant party_id changes across versions: ${sortedParticipants.join(', ')}`);
    }
    this.participant = sortedParticipants[0] ?? '';

    // A term id keeps its kind, consent_domain and declared_by.
    const kinds = new Map<string, string>();
    this.versions.forEach((v, i) =>
      v.terms.forEach((t, j) => {
        const key = JSON.stringify([t.kind, t.consent_domain, t.declared_by ?? null]);
        const first = kinds.get(t.term_id);
        if (first === undefined) kinds.set(t.term_id, key);
        else if (first !== key) {
          this.err(
            'R5',
            `/agreements/${i}/agreement/terms/${j}`,
            `term ${t.term_id} changes kind, consent_domain or declared_by across versions`,
          );
        }
      }),
    );
    // A term id or party id that a version drops never returns: one party for the whole record.
    const termVersions = new Map<string, number[]>();
    const partyVersions = new Map<string, number[]>();
    for (const v of this.versions) {
      for (const tid of this.d.terms(v).keys()) appendTo(termVersions, tid, v.version);
      for (const pid of this.d.parties(v).keys()) appendTo(partyVersions, pid, v.version);
    }
    for (const tid of this.d.allTermIds()) {
      const vs = termVersions.get(tid) ?? [];
      if (!isRun(vs)) {
        this.err(
          'R5',
          '/agreements',
          `term ${tid} returns after being dropped (versions ${vs.join(', ')})`,
        );
      }
    }
    for (const pid of [...partyVersions.keys()].sort(byCodePoint)) {
      const vs = partyVersions.get(pid) ?? [];
      if (!isRun(vs)) {
        this.err(
          'R5',
          '/agreements',
          `party ${pid} returns after being dropped (versions ${vs.join(', ')})`,
        );
      }
    }
  }

  /** R3 and R4 within one version. */
  private checkVersionRefs(v: Agreement, n: number, at: string): void {
    const parties = this.d.parties(v);
    const lists: [string, string, string[]][] = [
      ['party', 'parties', v.parties.map((p) => p.party_id)],
      ['term', 'terms', v.terms.map((t) => t.term_id)],
      ['compensation', 'compensation', v.compensation.map((x) => x.compensation_id)],
    ];
    for (const [kind, member, ids] of lists) {
      if (new Set(ids).size !== ids.length) this.err('R3', `${at}/${member}`, `version ${n}: duplicate ${kind} ids`);
    }
    const comp = new Set(v.compensation.map((x) => x.compensation_id));
    const participant = this.participantOf(v);
    v.parties.forEach((p, j) => {
      if (p.roles.includes('authorized_representative') && p.represents !== participant) {
        this.err(
          'R3',
          `${at}/parties/${j}/represents`,
          `version ${n}: ${p.party_id} represents ${p.represents}, not the participant`,
        );
      }
      const ver = p.verification;
      if (ver !== undefined && !(ver.verified_by.startsWith('https://') || parties.has(ver.verified_by))) {
        this.err(
          'R3',
          `${at}/parties/${j}/verification/verified_by`,
          `version ${n}: verification.verified_by ${ver.verified_by} is unknown`,
        );
      }
    });
    v.terms.forEach((t, j) => {
      const tat = `${at}/terms/${j}`;
      const tid = t.term_id;
      if (t.consent_domain === 'asset' && !this.hasRole(v, t.declared_by, 'rights_holder')) {
        this.err('R3', `${tat}/declared_by`, `version ${n}: ${tid} declared_by is not a rights holder`);
      }
      const from = instant(t.valid_from);
      if (t.valid_until !== undefined && instant(t.valid_until) <= from) {
        this.err('R4', `${tat}/valid_until`, `version ${n}: ${tid} valid_until is not after valid_from`);
      }
      if (t.kind !== 'grant') return;
      if (instant(t.valid_until) > plusYears(from, 10)) {
        this.err('R4', `${tat}/valid_until`, `version ${n}: ${tid} lasts more than 10 years`);
      }
      t.licensees.forEach((lic, k) => {
        if (!this.hasRole(v, lic, 'licensee')) {
          this.err('R3', `${tat}/licensees/${k}`, `version ${n}: ${tid} licensee ${lic} lacks role licensee`);
        }
      });
      (t.scope.sublicensing?.to ?? []).forEach((s, k) => {
        if (!this.hasRole(v, s, 'sublicensee')) {
          this.err(
            'R3',
            `${tat}/scope/sublicensing/to/${k}`,
            `version ${n}: ${tid} sublicensee ${s} lacks role sublicensee`,
          );
        }
      });
      t.compensation.forEach((cid, k) => {
        if (!comp.has(cid)) {
          this.err(
            'R3',
            `${tat}/compensation/${k}`,
            `version ${n}: ${tid} references unknown compensation ${cid}`,
          );
        }
      });
    });
    v.compensation.forEach((x, j) => {
      if (x.model !== 'unpaid' && (!this.hasRole(v, x.payer, 'payer') || !this.hasRole(v, x.payee, 'payee'))) {
        this.err('R3', `${at}/compensation/${j}`, `version ${n}: ${x.compensation_id} payer or payee lacks the role`);
      }
    });
    (v.asset_rights ?? []).forEach((a, j) => {
      if (!this.hasRole(v, a.rights_holder, 'rights_holder')) {
        this.err(
          'R3',
          `${at}/asset_rights/${j}/rights_holder`,
          `version ${n}: asset_rights names ${a.rights_holder}, not a rights holder`,
        );
      }
    });
    const holder = v.biometric_identifiers.holder;
    if (holder !== undefined && holder !== '' && !parties.has(holder)) {
      this.err('R3', `${at}/biometric_identifiers/holder`, `version ${n}: biometric holder is unknown`);
    }
    const doc = v.consent_document;
    if (instant(doc.presented_at) > instant(doc.signed_at)) {
      this.err(
        'R4',
        `${at}/consent_document/signed_at`,
        `version ${n}: consent document signed before it was presented`,
      );
    }
    const ret = v.retention;
    if (ret.record_until !== null && instant(ret.record_until) < instant(ret.disclosures_until)) {
      this.err('R4', `${at}/retention/record_until`, `version ${n}: record_until is before disclosures_until`);
    }
  }

  // ---------- R6, R7: signatures and keys ----------

  /**
   * R7 (`alg` fits the key) and R6 (one key per signer; the key binding). `party` is the
   * signer's entry; without it (an authority) the binding is not checked. `recording` is
   * absent for a version that has no version event yet.
   */
  private keyChecks(sig: Signature, where: string, at: string, party: Party | undefined, recording?: Recording): void {
    if (!algMatchesJwk(sig.alg, sig.jwk)) {
      this.err(
        'R7',
        `${at}/alg`,
        `${where}: alg ${sig.alg} does not match the jwk`,
      );
    }
    const owner = this.keyOwners.get(sig.kid);
    if (owner === undefined) this.keyOwners.set(sig.kid, sig.signer);
    else if (owner !== sig.signer) this.err('R6', `${at}/kid`, `${where}: key ${sig.kid} also signs for ${owner}`);
    const kb = sig.key_binding;
    // No binding: the signer is an authority signing for a party actor, which R14 reports.
    if (party === undefined || kb === undefined) return;
    if (recording !== undefined) {
      // The binding was verified by the authority in charge then, before the signature was
      // recorded.
      const verified = instant(kb.verified_at);
      if (verified > recording.recorded) {
        this.err(
          'R6',
          `${at}/key_binding/verified_at`,
          `${where}: key binding verified after the signature was recorded`,
        );
      }
      const authority = this.authorityAt(verified, recording.length);
      if (kb.verified_by !== undefined && kb.verified_by !== authority) {
        this.err(
          'R6',
          `${at}/key_binding/verified_by`,
          `${where}: key_binding.verified_by ${kb.verified_by} is not the authority in charge at verified_at (${authority})`,
        );
      }
      // An authority signs with a key it manages only while it is in charge.
      if (kb.custody === 'authority_managed' && kb.verified_by !== this.authorityAt(instant(sig.signed_at), recording.length)) {
        this.err(
          'R6',
          `${at}/key_binding/custody`,
          `${where}: the authority managing this key (${kb.verified_by}) is not in charge at signed_at`,
        );
      }
    }
    if (kb.method === 'did') {
      const didUrl = kb.did_url ?? '';
      const did = DID.exec(didUrl)?.[0] ?? didUrl;
      if (!this.didsOf(party).has(did)) {
        this.err(
          'R6',
          `${at}/key_binding/did_url`,
          `${where}: did_url ${did} is not a DID listed in clear for ${party.party_id}`,
        );
      }
    } else if (kb.method === 'x509') {
      // The certificate must name the party. The check here covers a certificate digest; a
      // domain or LEI needs the certificate itself, so here there only has to be a name to
      // match.
      const { pinned, named } = this.certificatesOf(party);
      const ders = (kb.x5c ?? []).map(fromStrictBase64);
      ders.forEach((der, i) => {
        if (der === undefined) this.err('R7', `${at}/key_binding/x5c/${i}`, `${where}: x5c[${i}] is not base64`);
      });
      const der = ders[0];
      const leaf = der === undefined ? undefined : sha256(der);
      if (!(leaf !== undefined && pinned.has(leaf)) && !named) {
        this.err(
          'R6',
          `${at}/key_binding`,
          `${where}: x509 key binding, but ${party.party_id} lists in clear no domain, lei or x509_sha256 of this certificate`,
        );
      }
    }
  }

  /**
   * R6: the participant and every licensee of a grant, plus each party whose own entry,
   * items, licenses or declarations this version changes. Values compare in committed form.
   */
  private requiredSigners(idx: number, v: Agreement): Set<string> {
    const required = new Set<string>([this.participantOf(v)]);
    for (const t of v.terms) if (t.kind === 'grant') for (const l of t.licensees) required.add(l);
    const prev: Previous = this.versions[idx - 1] ?? NO_VERSION;
    const same = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && this.canon(a) === this.canon(b);

    // A party's own entry: identifiers and identity bindings tie its keys to it.
    const partiesNow = this.d.parties(v);
    for (const [pid, p] of this.d.parties(prev)) {
      const q = partiesNow.get(pid);
      if (q !== undefined && !same(p, q)) required.add(pid);
    }

    // Terms withdrawn or ended when this version takes effect, judged on the events before its
    // version event.
    const termsBefore = this.d.terms(prev);
    const termsNow = this.d.terms(v);
    const found = this.versionEvent(v.version);
    const effect = found && { at: instant(found.event.effective_at), length: found.index };
    const final = new Set<string>();
    if (effect !== undefined) {
      for (const tid of new Set([...termsBefore.keys(), ...termsNow.keys()])) {
        if (this.d.isFinal(tid, effect.at, effect.length)) final.add(tid);
      }
    }

    // Terms by term_id, a grant together with the end rule that governs it, as the key of its
    // comparable text.
    const declaration = (t: Term | undefined, ver: Previous): string | undefined =>
      t === undefined ? undefined : this.declarationOf(t, ver);

    // Compensation items by compensation_id, together with the live grants that name them, each
    // with its end rule: what a grant covers (scope, max_assets, validity, what stays in use
    // after it) sets what is owed.
    const item = (ver: Previous, cid: string): readonly [Compensation, string[]] | undefined => {
      const x = this.compensationsOf(ver).get(cid);
      if (x === undefined) return undefined;
      const naming = this.grantsByCompensationOf(ver).get(cid) ?? [];
      this.work.spend(naming.length);
      const grants = naming
        .filter((t) => !final.has(t.term_id))
        .map((t) => this.declarationOf(t, ver))
        .sort();
      return [x, grants];
    };
    for (const cid of new Set([...prev.compensation, ...v.compensation].map((x) => x.compensation_id))) {
      const a = item(prev, cid);
      const b = item(v, cid);
      if (same(a, b)) continue;
      for (const it of [a, b]) {
        if (it === undefined) continue;
        if (it[0].payer !== undefined) required.add(it[0].payer);
        if (it[0].payee !== undefined) required.add(it[0].payee);
      }
    }

    for (const tid of [...new Set([...termsBefore.keys(), ...termsNow.keys()])].sort(byCodePoint)) {
      const a = termsBefore.get(tid);
      const b = termsNow.get(tid);
      const before = declaration(a, prev);
      if (before !== undefined && before === declaration(b, v)) continue;
      // The term as it stands when this version takes effect.
      const st = a !== undefined && effect !== undefined ? this.d.evaluate(tid, effect.at, effect.length) : undefined;
      // Dropping a withdrawn or ended term changes nothing.
      if (b === undefined && final.has(tid)) continue;
      if (a !== undefined && a.kind === 'grant') {
        for (const l of st?.effective?.licensees ?? a.licensees) required.add(l);
      }
      if ((b ?? a)?.consent_domain === 'asset') {
        for (const x of [a, b]) if (x?.declared_by !== undefined) required.add(x.declared_by);
      }
    }

    // Each rights holder's asset_rights entries, as a set.
    const entries = (ver: Previous): Map<string, string> => {
      const byHolder = new Map<string, Set<string>>();
      for (const x of ver.asset_rights ?? []) addTo(byHolder, x.rights_holder, this.canon(x));
      return new Map([...byHolder].map(([holder, set]) => [holder, [...set].sort().join('\n')]));
    };
    const rightsBefore = entries(prev);
    const rightsNow = entries(v);
    for (const holder of new Set([...rightsBefore.keys(), ...rightsNow.keys()])) {
      if (rightsBefore.get(holder) !== rightsNow.get(holder)) required.add(holder);
    }

    // The party that declares it holds biometric identifiers, before and after.
    const bioBefore = prev.biometric_identifiers;
    const bioNow = v.biometric_identifiers;
    if (!same(bioBefore, bioNow)) {
      for (const x of [bioBefore, bioNow]) if (x?.holder !== undefined) required.add(x.holder);
    }
    return required;
  }

  /**
   * The SHA-256 of a term's comparable text for R6: a grant together with the end rule that
   * governs it in `ver`, its version. Made once per version and term: a record given as a
   * value may share one term object between versions whose end rules differ.
   */
  private declarationOf(t: Term, ver: Previous): string {
    let keys = this.declarations.get(ver);
    if (keys === undefined) this.declarations.set(ver, (keys = new WeakMap()));
    let key = keys.get(t);
    if (key === undefined) {
      key = sha256(this.canon(t.kind === 'grant' ? [t, t.end_of_use ?? ver.end_of_use ?? null] : [t]));
      keys.set(t, key);
    }
    return key;
  }

  /** A version's compensation items by compensation_id; with duplicates (R3) the first one. */
  private compensationsOf(ver: Previous): ReadonlyMap<string, Compensation> {
    let map = this.compensations.get(ver);
    if (map === undefined) {
      this.work.spend(ver.compensation.length);
      const items = new Map<string, Compensation>();
      for (const x of ver.compensation) if (!items.has(x.compensation_id)) items.set(x.compensation_id, x);
      this.compensations.set(ver, (map = items));
    }
    return map;
  }

  /** A version's grants by each compensation_id they name, in the order of its terms. */
  private grantsByCompensationOf(ver: Previous): ReadonlyMap<string, readonly Grant[]> {
    let map = this.grantsByCompensation.get(ver);
    if (map === undefined) {
      const grants = new Map<string, Grant[]>();
      for (const t of ver.terms) {
        if (t.kind !== 'grant') continue;
        this.work.spend(t.compensation.length);
        for (const cid of new Set(t.compensation)) appendTo(grants, cid, t);
      }
      this.grantsByCompensation.set(ver, (map = grants));
    }
    return map;
  }

  private checkSignatures(): void {
    this.r.agreements.forEach((item, idx) => {
      const v = item.agreement;
      const n = v.version;
      const parties = this.d.parties(v);
      const signers = item.signatures.map((s) => s.signer);
      const found = this.versionEvent(n);
      const at = `/agreements/${idx}/signatures`;
      const signed = new Set(signers);
      if (signed.size !== signers.length) this.err('R6', at, `version ${n}: a party signs twice`);
      const missing = [...this.requiredSigners(idx, v)].filter((s) => !signed.has(s)).sort(byCodePoint);
      for (const m of missing) {
        if (parties.has(m)) this.err('R6', at, `version ${n}: required signer ${m} did not sign`);
        else this.err('R6', at, `version ${n}: required signer ${m} is not listed as a party`);
      }
      const recording = found && { length: found.index, recorded: instant(found.event.recorded_at) };
      item.signatures.forEach((s, j) => {
        const sat = `${at}/${j}`;
        const where = `version ${n} signature by ${s.signer}`;
        const party = parties.get(s.signer);
        if (party === undefined) {
          this.err('R6', `${sat}/signer`, `${where}: signer is not a party`);
          return;
        }
        const stmt = this.statement('agreement', item.agreement_digest.value, s.signer, s.signed_at);
        for (const p of this.verify(s, stmt)) this.err('R7', sat, `${where}: ${p}`);
        this.keyChecks(s, where, sat, party, recording);
        if (instant(s.signed_at) < instant(v.created_at)) {
          this.err('R6', `${sat}/signed_at`, `${where}: signed before the agreement was created`);
        }
        if (s.signer === this.participantOf(v)) {
          if (instant(s.signed_at) < instant(v.consent_document.presented_at)) {
            this.err(
              'R6',
              `${sat}/signed_at`,
              `${where}: participant signed before the consent document was presented`,
            );
          }
          const verification = party.verification;
          if (verification !== undefined && instant(verification.verified_at) > instant(s.signed_at)) {
            this.err('R6', `${sat}/signed_at`, `${where}: participant verified after signing`);
          }
        }
      });
    });
  }

  // ---------- R5, R8–R16: events ----------

  /**
   * R10: the authority in charge at `t`, by the hand-overs among the first `length` events: the
   * last of them recorded by `t`, as each takes effect when it is recorded.
   */
  private authorityAt(t: number, length: number): string {
    const { positions, recorded, to } = this.handOvers;
    const n = countBelow(positions, length);
    let j: number;
    if (this.handOversInOrder) {
      j = Math.min(n, countAtOrBelow(recorded, t)) - 1;
    } else {
      // Out of time order, which R8 reports.
      for (j = n - 1; j >= 0 && recorded[j]! > t; j--) this.work.spend(1);
    }
    return j >= 0 ? to[j]! : (this.versions[0]?.authority_id ?? '');
  }

  /**
   * R13: the first version recorded among the first `length` events that takes effect after
   * `at` and contains `tid`.
   */
  private laterSource(tid: string, at: number, length: number): VersionEffect | undefined {
    const effects = this.d.versionEvents(length);
    // The first that takes effect after `at`: they are in order of effect time.
    let lo = 0;
    let hi = effects.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (effects[mid]!.at <= at) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < effects.length; i++) {
      this.work.spend(1);
      const x = effects[i]!;
      if (x.version <= this.versions.length && this.d.termsOf(x.version).has(tid)) return x;
    }
    return undefined;
  }

  /**
   * R12: the actor is an authorized representative while its appointment is in force, that
   * is, in the version in force when the event takes effect (version 1 before that).
   */
  private represents(e: RecordEvent, length: number): boolean {
    const k = this.d.versionAt(instant(e.effective_at), length) ?? 1;
    const p = this.d.partiesOf(k).get(e.actor);
    return p !== undefined && p.roles.includes('authorized_representative');
  }

  /**
   * R12: the actor's entry, which makes it a party and holds its key binding: in the version
   * in force when the event takes effect (version 1 before that), or else in the earliest
   * version that the event's grants (R13) or compensation item (R15) come from.
   */
  private actorParty(e: RecordEvent, length: number, items: ReadonlyMap<string, PaymentItem>): Party | undefined {
    const at = instant(e.effective_at);
    const k = this.d.versionAt(at, length) ?? 1;
    const sources: (number | undefined)[] = [k];
    if (isInstruction(e)) {
      const inForce = this.d.termsOf(k);
      this.work.spend(e.term_ids.length);
      for (const tid of e.term_ids) if (!inForce.has(tid)) sources.push(this.laterSource(tid, at, length)?.version);
    } else if (e.type === 'payment_recorded' && this.payments.has(e.ref)) {
      const pay = this.payments.get(e.ref);
      if (pay !== undefined) sources.push(this.compensationAt(pay.compensation_id, instant(pay.paid_at), length)?.version);
    } else if (isPaymentEvent(e)) {
      sources.push(items.get(e.ref)?.version);
    }
    const ordered = [...new Set(sources.filter((n): n is number => n !== undefined))].sort(
      (x, y) => Number(x !== k) - Number(y !== k) || x - y,
    );
    for (const n of ordered) {
      const p = this.d.partiesOf(n).get(e.actor);
      if (p !== undefined) return p;
    }
    return undefined;
  }

  /**
   * R15: the item as it stands at `t`: in the latest version in force at `t` that contains
   * it, or else, for a payment ahead of a version that takes effect later, in the first such
   * version recorded in `events`.
   */
  private compensationAt(
    cid: string,
    t: number,
    length: number,
  ): { readonly version: number; readonly item: Compensation } | undefined {
    const item = (n: number): Compensation | undefined => {
      const v = this.d.version(n);
      return v === undefined ? undefined : this.compensationsOf(v).get(cid);
    };
    const k = this.d.versionAt(t, length) ?? 0;
    for (let n = k; n > 0; n--) {
      this.work.spend(1);
      const x = item(n);
      if (x !== undefined) return { version: n, item: x };
    }
    for (const { version: n } of this.d.versionEvents(length)) {
      this.work.spend(1);
      if (k < n && n <= this.versions.length) {
        const x = item(n);
        if (x !== undefined) return { version: n, item: x };
      }
    }
    return undefined;
  }

  private checkEvents(): void {
    const r = this.r;
    const asOf = instant(r.state.as_of);
    let authority = this.versions[0]?.authority_id ?? '';
    let expectedVersion = 1;
    let lastVersionAt: number | undefined;
    let lastRecorded: number | undefined;
    const paymentItems = new Map<string, PaymentItem>();
    const live = new LiveBindings(this.bindings);
    /** Digest of a signed statement → seq of the first event that carries it (R14). */
    const signedStatements = new Map<string, number>();
    this.events.forEach((e, i) => {
      const at = `/state/events/${i}`;
      const where = `event ${e.seq} (${e.type})`;
      // The events before this one, which rules about its time judge it against (D21).
      const before = i;
      this.work.spend(1);
      const rec = instant(e.recorded_at);
      const eff = instant(e.effective_at);
      const actor = e.actor;
      const byAuthority = isAuthority(actor);
      const party = byAuthority ? undefined : this.actorParty(e, before, paymentItems);

      // R8: chain and order.
      if (e.seq !== i + 1) this.err('R8', `${at}/seq`, `${where}: seq should be ${i + 1}`);
      const previous = i > 0 ? this.events[i - 1] : undefined;
      const wantPrev = previous === undefined ? null : this.digestOnce(previous);
      if (e.prev_digest !== wantPrev) {
        this.err(
          'R8',
          `${at}/prev_digest`,
          `${where}: prev_digest does not match the previous event`,
        );
      }
      if (lastRecorded !== undefined && rec < lastRecorded) {
        this.err(
          'R8',
          `${at}/recorded_at`,
          `${where}: recorded_at goes back in time`,
        );
      }
      lastRecorded = rec;
      if (rec > asOf) this.err('R8', `${at}/recorded_at`, `${where}: recorded after as_of`);

      // R11: timing.
      if (e.received_at !== undefined && instant(e.received_at) > rec) {
        this.err('R11', `${at}/received_at`, `${where}: received after it was recorded`);
      }
      if (!byAuthority && isInstruction(e) && e.received_at === undefined) {
        this.err('R11', at, `${where}: an instruction from a party needs received_at`);
      }
      if (!byAuthority && (e.type === 'narrowed' || e.type === 'suspended' || e.type === 'withdrawn')) {
        if (e.received_at !== undefined) {
          const got = instant(e.received_at);
          if (eff < got) this.err('R11', `${at}/effective_at`, `${where}: takes effect before it was received`);
          else if (eff > got && e.actor_signature === undefined) {
            this.err(
              'R11',
              `${at}/effective_at`,
              `${where}: takes effect after it was received without the actor's signature over that time`,
            );
          }
        }
      } else if (!isPaymentEvent(e) && eff < rec) {
        this.err('R11', `${at}/effective_at`, `${where}: takes effect before it was recorded`);
      } else if (e.type === 'asset_unbound' && eff !== rec) {
        this.err('R11', `${at}/effective_at`, `${where}: an unbinding takes effect when it is recorded`);
      }

      // R10: the authority in charge.
      if (byAuthority && actor !== authority) {
        this.err('R10', `${at}/actor`, `${where}: actor ${actor} is not the authority in charge (${authority})`);
      }
      if (isVersionEvent(e)) {
        this.checkVersionEvent(e, before, where, at, authority, expectedVersion, lastVersionAt, asOf);
        lastVersionAt = eff;
        expectedVersion += 1;
      }
      if (!byAuthority && party === undefined) {
        this.err(
          'R12',
          `${at}/actor`,
          `${where}: actor ${actor} is not a party`,
        );
      }
      if (e.on_behalf_of !== undefined && (!this.represents(e, before) || e.on_behalf_of !== this.participant)) {
        this.err(
          'R12',
          `${at}/on_behalf_of`,
          `${where}: on_behalf_of is only for a representative acting for the participant`,
        );
      }
      if (isInstruction(e)) this.checkInstruction(e, before, where, at, byAuthority);
      if (isPaymentEvent(e)) this.checkPaymentEvent(e, before, where, at, byAuthority, rec, eff, paymentItems);
      if (e.type === 'asset_bound') {
        if (!byAuthority) this.err('R12', `${at}/actor`, `${where}: only the authority binds assets`);
        const b = this.bindings.get(e.ref);
        if (b === undefined) {
          this.err('R12', `${at}/ref`, `${where}: unknown binding ${e.ref}`);
        } else {
          if (live.wasBound(e.ref)) this.err('R12', `${at}/ref`, `${where}: binding recorded twice`);
          const label = b.c2pa.manifest_label;
          if (live.clashes(e.ref, label)) this.err('R16', `${at}/ref`, `${where}: manifest ${label} already has a live binding`);
          live.bind(e.ref);
          if (e.ref_digest !== this.digestOnce(b)) {
            this.err(
              'R12',
              `${at}/ref_digest`,
              `${where}: ref_digest does not match the binding`,
            );
          }
          this.checkBinding(b, eff, before, where, live);
        }
      }
      if (e.type === 'asset_unbound') {
        const b = this.bindings.get(e.ref);
        if (b === undefined || !live.wasBound(e.ref) || live.wasUnbound(e.ref)) {
          this.err('R12', `${at}/ref`, `${where}: unbinds an unknown or unbound binding`);
        } else if (!(byAuthority || actor === b.registered_by)) {
          this.err('R12', `${at}/actor`, `${where}: actor may not unbind`);
        }
        live.unbind(e.ref);
      }
      if (e.type === 'correction') {
        if (e.ref_seq >= e.seq) this.err('R12', `${at}/ref_seq`, `${where}: corrects a later event`);
        if (!byAuthority) this.err('R12', `${at}/actor`, `${where}: only the authority records corrections`);
      }
      const s = e.actor_signature;
      if (s !== undefined) {
        const sat = `${at}/actor_signature`;
        if (s.signer !== actor) this.err('R14', `${sat}/signer`, `${where}: actor_signature signer is not the actor`);
        const [kind, part] = signedPart(e);
        const stmt = this.statement(kind, sha256(this.canon(part)), s.signer, s.signed_at);
        for (const p of this.verify(s, stmt)) this.err('R7', sat, `${where} actor_signature: ${p}`);
        // By statement, not by signature bytes: some algorithms allow several valid signatures.
        this.work.spend(statementSteps(stmt));
        const d = digestOf(stmt);
        const first = signedStatements.get(d);
        if (first !== undefined) {
          this.err('R14', sat, `${where}: actor_signature repeats the signed statement of event ${first}`);
        } else {
          signedStatements.set(d, e.seq);
        }
        this.keyChecks(s, where, sat, party, { length: before, recorded: rec });
        const limit = e.received_at !== undefined ? instant(e.received_at) : rec;
        if (instant(s.signed_at) > limit) {
          this.err('R14', `${sat}/signed_at`, `${where}: actor signed after the authority received the instruction`);
        }
      }
      if (e.type === 'authority_transferred') {
        if (eff !== rec) {
          this.err(
            'R10',
            `${at}/effective_at`,
            `${where}: a hand-over takes effect when it is recorded`,
          );
        }
        if (e.to_authority === actor) {
          this.err(
            'R10',
            `${at}/to_authority`,
            `${where}: hands the record over to the same authority`,
          );
        }
        if (!sameOrigin(e.keys_uri, actor)) {
          this.err('R10', `${at}/keys_uri`, `${where}: keys_uri is not on the origin of the transferring authority`);
        }
        authority = e.to_authority;
      }
    });
    if (r.authority.id !== authority) {
      this.err(
        'R10',
        '/authority/id',
        `serving authority ${r.authority.id} is not the authority in charge (${authority})`,
      );
    }
    if (expectedVersion !== this.versions.length + 1) {
      this.err(
        'R9',
        '/state/events',
        expectedVersion <= this.versions.length ? 'not every version has a version event' : 'more version events than versions',
      );
    }
    if (!sameOrigin(r.authority.id, r.authority.keys_uri)) {
      this.err('R10', '/authority/keys_uri', "keys_uri is not on the authority's origin");
    }
  }

  /** R9, R10 and R5 for an `issued` or `version_added` event. */
  private checkVersionEvent(
    e: VersionEvent,
    before: number,
    where: string,
    at: string,
    authority: string,
    expectedVersion: number,
    lastVersionAt: number | undefined,
    asOf: number,
  ): void {
    const rec = instant(e.recorded_at);
    const eff = instant(e.effective_at);
    const n = e.version;
    if (n !== expectedVersion) {
      this.err(
        'R9',
        `${at}/version`,
        `${where}: version ${n} out of order, expected ${expectedVersion}`,
      );
    }
    if (n === 1 && eff > asOf) this.err('R9', `${at}/effective_at`, `${where}: version 1 takes effect after as_of`);
    if (lastVersionAt !== undefined && eff <= lastVersionAt) {
      this.err('R9', `${at}/effective_at`, `${where}: version effect times must increase`);
    }
    const item = this.r.agreements[n - 1];
    if (n > this.versions.length || item === undefined) {
      this.err('R9', `${at}/version`, `${where}: version ${n} does not exist`);
      return;
    }
    const v = item.agreement;
    const vat = `/agreements/${n - 1}/agreement`;
    // The whole item, so that the event chain fixes the signatures as well as the text.
    if (e.ref_digest !== this.digestOnce(item)) {
      this.err(
        'R9',
        `${at}/ref_digest`,
        `${where}: ref_digest is not the digest of agreements[${n - 1}]`,
      );
    }
    v.terms.forEach((t, j) => {
      if (t.valid_until === undefined) return;
      let end = instant(t.valid_until);
      if (t.kind === 'grant') {
        // An end_earlier already recorded keeps applying to the new text.
        const ends = this.endsEarlier.get(t.term_id);
        const n = ends === undefined ? 0 : countBelow(ends.positions, before);
        if (n > 0) end = Math.min(end, ends!.earliest[n - 1]!);
      }
      if (end <= eff) {
        this.err('R9', `${vat}/terms/${j}`, `${where}: ${t.term_id} ends before version ${n} takes effect`);
      } else if (end <= instant(t.valid_from)) {
        this.err(
          'R9',
          `${vat}/terms/${j}`,
          `${where}: ${t.term_id} ends, after an earlier narrowing, before its new valid_from`,
        );
      }
    });
    const latest = Math.max(instant(v.consent_document.signed_at), ...item.signatures.map((s) => instant(s.signed_at)));
    if (eff < latest || rec < latest) {
      this.err(
        'R9',
        at,
        `${where}: recorded or in effect before every signature exists`,
      );
    }
    if (v.authority_id !== authority) {
      this.err(
        'R10',
        `${vat}/authority_id`,
        `${where}: version ${n} names ${v.authority_id}, not the authority in charge (${authority})`,
      );
    }
    v.terms.forEach((t, j) => {
      if (this.d.isFinal(t.term_id, eff, before)) {
        this.err(
          'R5',
          `${vat}/terms/${j}`,
          `${where}: version ${n} restates ${t.term_id}, which is withdrawn or ended when it takes effect`,
        );
      }
    });
  }

  /**
   * R12 and R15 for a payment event. `items` holds the item each recorded payment was made
   * under.
   */
  private checkPaymentEvent(
    e: PaymentEvent,
    before: number,
    where: string,
    at: string,
    byAuthority: boolean,
    rec: number,
    eff: number,
    items: Map<string, PaymentItem>,
  ): void {
    const pay = this.payments.get(e.ref);
    if (pay === undefined) {
      this.err('R12', `${at}/ref`, `${where}: unknown payment ${e.ref}`);
      return;
    }
    let ok: boolean;
    if (e.type === 'payment_recorded') {
      if (items.has(e.ref)) this.err('R12', `${at}/ref`, `${where}: payment recorded twice`);
      if (e.ref_digest !== this.digestOnce(pay)) {
        this.err(
          'R12',
          `${at}/ref_digest`,
          `${where}: ref_digest does not match the payment`,
        );
      }
      const paid = instant(pay.paid_at);
      if (paid > rec) this.err('R15', `${at}/recorded_at`, `${where}: paid_at is after the event was recorded`);
      if (eff !== paid) {
        this.err(
          'R15',
          `${at}/effective_at`,
          `${where}: takes effect at ${e.effective_at}, not at paid_at`,
        );
      }
      const found = this.compensationAt(pay.compensation_id, paid, before);
      let comp = found?.item;
      if (comp === undefined) {
        this.err(
          'R15',
          `${at}/ref`,
          `${where}: payment ${e.ref} references no compensation item of a recorded version`,
        );
      } else if (comp.model === 'unpaid') {
        this.err('R15', `${at}/ref`, `${where}: payment ${e.ref} is for an unpaid item`);
        comp = undefined;
      }
      // Later events about this payment keep the payer and payee it was made under.
      if (!items.has(e.ref)) items.set(e.ref, { version: found?.version, item: comp });
      ok = byAuthority || (comp !== undefined && e.actor === comp.payer);
    } else {
      if (!items.has(e.ref)) this.err('R12', `${at}/ref`, `${where}: payment event before payment_recorded`);
      if (eff < instant(pay.paid_at)) {
        this.err(
          'R15',
          `${at}/effective_at`,
          `${where}: takes effect before the payment was made`,
        );
      }
      if (eff > rec) this.err('R15', `${at}/effective_at`, `${where}: takes effect after it was recorded`);
      const comp = items.get(e.ref)?.item;
      // A representative acts for the participant as payee or payer (on_behalf_of is checked in
      // checkEvents).
      const parties: (string | undefined)[] =
        comp === undefined ? [] : e.type === 'payment_confirmed' ? [comp.payee] : [comp.payer, comp.payee];
      ok = parties.includes(e.actor) || (e.on_behalf_of !== undefined && parties.includes(e.on_behalf_of));
    }
    if (!ok) this.err('R12', `${at}/actor`, `${where}: actor ${e.actor} may not do this`);
  }

  /** R12 and R13 for `narrowed`, `suspended`, `resumed` and `withdrawn`. */
  private checkInstruction(
    e: InstructionEvent,
    before: number,
    where: string,
    at: string,
    byAuthority: boolean,
  ): void {
    const eff = instant(e.effective_at);
    if (byAuthority && (e.type === 'narrowed' || e.type === 'withdrawn')) {
      this.err('R12', `${at}/actor`, `${where}: the authority cannot narrow or withdraw`);
    }
    const k = this.d.versionAt(eff, before);
    const inForce = k === undefined ? new Map<string, Term>() : this.d.termsOf(k);
    this.work.spend(e.term_ids.length);
    e.term_ids.forEach((tid, j) => {
      const tat = `${at}/term_ids/${j}`;
      let term = inForce.get(tid);
      let when = eff;
      if (term === undefined) {
        // A grant of a version recorded earlier that takes effect later: judged as it stands
        // when it comes into existence.
        const source = this.laterSource(tid, eff, before);
        if (source === undefined) {
          this.err(
            'R13',
            tat,
            `${where}: term ${tid} is neither in the version in force nor in a recorded later version`,
          );
          return;
        }
        when = source.at;
        term = this.d.termsOf(source.version).get(tid);
        if (term === undefined) return; // laterSource found it there
      }
      if (term.kind !== 'grant') {
        this.err(
          'R13',
          tat,
          `${where}: ${tid} is a prohibition; only grants can be narrowed, suspended, resumed or withdrawn`,
        );
        return;
      }
      if (term.consent_domain === 'asset' && e.on_behalf_of !== undefined) {
        this.err(
          'R12',
          `${at}/on_behalf_of`,
          `${where}: ${tid} is an asset grant; its rights holder acts in its own name, without on_behalf_of`,
        );
      }
      if (!byAuthority && e.type !== 'resumed') {
        const allowed =
          term.consent_domain === 'identity'
            ? e.actor === this.participant || (this.represents(e, before) && e.on_behalf_of === this.participant)
            : e.actor === term.declared_by;
        if (!allowed) this.err('R12', `${at}/actor`, `${where}: actor ${e.actor} may not act on ${tid}`);
      }
      const st = this.d.evaluate(tid, when, before);
      if (st === undefined || !LIVE.has(st.status)) {
        this.err('R13', tat, `${where}: ${tid} is ${st?.status ?? 'not yet in any version'} at ${iso(when)}`);
        return;
      }
      if (e.type === 'resumed') {
        this.checkResumption(e, tid, before, where, at, byAuthority);
        return;
      }
      // Without an effective grant the text there is not a grant, which R5 reports.
      const effective = st.effective;
      if (effective === undefined) return;
      if (e.type === 'withdrawn' && when >= instant(effective.valid_until)) {
        this.err('R13', tat, `${where}: withdrawal takes effect after the grant ends`);
      }
      if (e.type === 'narrowed') this.checkNarrowing(e.narrowing, effective, term, when, where, `${at}/narrowing`, tid);
    });
  }

  /** R12 and R13 for a `resumed` event: it lifts its suspension (`ref_seq`) for `tid`. */
  private checkResumption(
    e: ResumedEvent,
    tid: string,
    before: number,
    where: string,
    at: string,
    byAuthority: boolean,
  ): void {
    const eff = instant(e.effective_at);
    const first = this.suspensionsBySeq.get(e.ref_seq)?.[0];
    const sus = first !== undefined && first < before ? (this.events[first] as SuspendedEvent) : undefined;
    if (sus !== undefined) this.work.spend(sus.term_ids.length);
    if (sus === undefined || !sus.term_ids.includes(tid)) {
      this.err('R13', `${at}/ref_seq`, `${where}: ref_seq is not a suspension of ${tid}`);
      return;
    }
    if (instant(sus.effective_at) > eff) {
      this.err(
        'R13',
        `${at}/effective_at`,
        `${where}: takes effect before the suspension it lifts`,
      );
    }
    if ((this.firstResumption.get(`${sus.seq} ${tid}`) ?? Infinity) < before) {
      this.err('R13', `${at}/ref_seq`, `${where}: suspension ${sus.seq} of ${tid} was already lifted`);
    }
    let ok: boolean;
    if (isAuthority(sus.actor)) {
      // An authority's suspension: the authority in charge now (R10), also after a hand-over.
      ok = byAuthority;
    } else if (sus.on_behalf_of !== undefined) {
      // A representative's suspension for the participant: the participant, or the same
      // representative acting for the participant while still appointed (on_behalf_of is
      // checked in checkEvents).
      ok = e.actor === this.participant || (e.actor === sus.actor && e.on_behalf_of === this.participant);
    } else {
      ok = e.actor === sus.actor;
    }
    if (!ok) this.err('R12', `${at}/actor`, `${where}: may not lift suspension ${sus.seq} of ${tid}`);
  }

  /** R13: every narrowing operation changes the grant as it stands at `at`. */
  private checkNarrowing(n: Narrowing, eff: Effective, term: Term, at: number, where: string, ptr: string, tid: string): void {
    const s = eff.scope;
    // The grant and the narrowing's own lists, once for each term the narrowing names.
    this.work.spend(valuesIn(eff) + valuesListed(n));
    // A message is made only for a check that fails: most pass, and a narrowing may list many
    // values.
    const need = (cond: boolean, msg: string | (() => string)): void => {
      if (!cond) this.err('R13', ptr, `${where}: ${tid}: ${typeof msg === 'string' ? msg : msg()}`);
    };
    // Membership by set: a narrowing and the grant may each list many values.
    const uses = new Set(eff.uses);
    for (const u of n.remove_uses ?? []) need(uses.has(u), () => `remove_uses ${u} is not granted`);
    if (n.remove_identity_attributes !== undefined) {
      need(term.consent_domain === 'identity', 'remove_identity_attributes on an asset grant');
      const attributes = new Set(eff.identity_attributes);
      for (const a of n.remove_identity_attributes) need(attributes.has(a), () => `attribute ${a} is not granted`);
    }
    const mediaTypes = new Set(s.media_types);
    for (const m of n.remove_media_types ?? []) need(mediaTypes.has(m), () => `media type ${m} is not granted`);
    const channels = new Set(s.channels);
    for (const ch of n.remove_channels ?? []) need(channels.has(ch), () => `channel ${ch} is not granted`);
    const included = new Set<string>(s.territories.include);
    const excluded = new Set(s.territories.exclude);
    for (const x of n.remove_territories ?? []) {
      if (isWorld(s.territories.include)) {
        need(!excluded.has(x), () => `territory ${x} is already excluded`);
      } else {
        need(included.has(x), () => `territory ${x} is not granted`);
      }
    }
    const prohibited = new Set(s.prohibited_contexts);
    for (const x of n.add_prohibited_contexts ?? []) need(!prohibited.has(x), () => `context ${x} is already prohibited`);
    const licensees = new Set(eff.licensees);
    for (const x of n.remove_licensees ?? []) need(licensees.has(x), () => `${x} is not a licensee`);
    const sub = s.sublicensing;
    if (n.forbid_sublicensing !== undefined) {
      need(sub !== undefined && sub.allowed, 'sublicensing is already not allowed');
    }
    const sublicensees = new Set(sub?.to);
    for (const x of n.remove_sublicensees ?? []) {
      need(sub !== undefined && sub.allowed && sublicensees.has(x), () => `${x} is not in sublicensing.to`);
    }
    const restrict = n.restrict_named_works;
    const have = s.named_works;
    if (restrict !== undefined && have !== undefined) {
      const kept = new Set(restrict);
      const named = new Set(have);
      for (const w of restrict) need(named.has(w), () => `named work ${JSON.stringify(w)} is not in the grant`);
      need(
        have.some((w) => !kept.has(w)),
        'restrict_named_works changes nothing',
      );
    }
    if (n.lower_max_assets !== undefined) {
      need(s.max_assets === undefined || n.lower_max_assets < s.max_assets, 'lower_max_assets does not lower');
    }
    if (n.end_earlier !== undefined) {
      const end = this.d.instant(n.end_earlier);
      need(at <= end && end < this.d.instant(eff.valid_until), 'end_earlier must lie between effective_at and the current end');
      need(end > this.d.instant(eff.valid_from), 'end_earlier must be after valid_from');
    }
  }

  /**
   * R16 at registration (`at`, the `asset_bound` event's effect). `bound` already holds this
   * binding.
   */
  private checkBinding(
    b: AssetBinding,
    at: number,
    before: number,
    where: string,
    live: LiveBindings,
  ): void {
    const bat = `/state/asset_bindings/${this.bindingIndex.get(b.binding_id) ?? 0}`;
    const category = b.media_type;
    if (b.mime_type !== undefined) {
      const allowed = MIME_CATEGORIES.get(b.mime_type.split('/')[0] ?? '');
      if (allowed !== undefined && !allowed.has(category)) {
        this.err(
          'R16',
          `${bat}/mime_type`,
          `${where}: mime_type ${b.mime_type} does not go with media_type ${category}`,
        );
      }
    }
    b.term_ids.forEach((tid, j) => {
      const tat = `${bat}/term_ids/${j}`;
      const st = this.d.evaluate(tid, at, before);
      if (st === undefined || st.effective === undefined) {
        this.err('R16', tat, `${where}: ${tid} is not a grant at registration`);
        return;
      }
      if (st.status !== 'in_force') this.err('R16', tat, `${where}: ${tid} is ${st.status} at registration`);
      const eff = st.effective;
      this.work.spend(eff.licensees.length + eff.scope.media_types.length);
      if (!eff.licensees.includes(b.registered_by)) {
        this.err('R16', `${bat}/registered_by`, `${where}: ${b.registered_by} is not a licensee of ${tid}`);
      }
      if (!eff.scope.media_types.includes(category)) {
        this.err('R16', `${bat}/media_type`, `${where}: media type ${category} is outside ${tid}`);
      }
      const max = eff.scope.max_assets;
      if (max !== undefined && live.naming(tid) > max) {
        this.err('R16', tat, `${where}: more than max_assets bindings for ${tid}`);
      }
    });
  }

  private checkPaymentsAndBindings(): void {
    const state = this.r.state;
    const payments = state.payments ?? [];
    const bindings = state.asset_bindings ?? [];
    if (new Set(payments.map((p) => p.payment_id)).size !== payments.length) {
      this.err('R15', '/state/payments', 'duplicate payment_id');
    }
    if (new Set(bindings.map((b) => b.binding_id)).size !== bindings.length) {
      this.err('R16', '/state/asset_bindings', 'duplicate binding_id');
    }
    const recorded = new Set(this.events.flatMap((e) => (e.type === 'payment_recorded' ? [e.ref] : [])));
    payments.forEach((p, j) => {
      if (!recorded.has(p.payment_id)) {
        this.err(
          'R15',
          `/state/payments/${j}`,
          `payment ${p.payment_id} has no payment_recorded event`,
        );
      }
    });
    const bound = new Set(this.events.flatMap((e) => (e.type === 'asset_bound' ? [e.ref] : [])));
    bindings.forEach((b, j) => {
      if (!bound.has(b.binding_id)) {
        this.err(
          'R16',
          `/state/asset_bindings/${j}`,
          `binding ${b.binding_id} has no asset_bound event`,
        );
      }
    });
  }

  // ---------- R17, R18: derived state ----------

  private derivedStates(t: number): Map<string, DerivedState & { readonly since: number }> {
    const out = new Map<string, DerivedState & { readonly since: number }>();
    for (const tid of this.d.allTermIds()) {
      const st = this.d.stateAt(tid, t, this.events.length);
      if (st !== undefined) out.set(tid, st);
    }
    return out;
  }

  private checkTermStates(): void {
    const state = this.r.state;
    const asOf = instant(state.as_of);
    const want = this.derivedStates(asOf);
    // With duplicate term ids (R17) the last entry wins.
    const have = new Map<string, { readonly entry: TermState; readonly index: number }>();
    state.term_states.forEach((entry, index) => have.set(entry.term_id, { entry, index }));
    if (have.size !== state.term_states.length) this.err('R17', '/state/term_states', 'duplicate term_states entries');
    const haveIds = [...have.keys()].sort(byCodePoint);
    const wantIds = [...want.keys()].sort(byCodePoint);
    if (haveIds.join('\n') !== wantIds.join('\n')) {
      this.err(
        'R17',
        '/state/term_states',
        `term_states covers [${haveIds.join(', ')}], expected [${wantIds.join(', ')}]`,
      );
    }
    for (const [tid, { entry: h, index }] of have) {
      const w = want.get(tid);
      if (w === undefined) continue;
      const at = `/state/term_states/${index}`;
      const pairs: [string, unknown, unknown][] = [
        ['status', h.status, w.status],
        ['version', h.version, w.version],
        ['narrowed', h.narrowed, this.d.narrowed(w)],
        ['end_reason', h.end_reason, w.end_reason],
      ];
      for (const [k, x, y] of pairs) {
        if (x !== y) this.err('R17', `${at}/${k}`, `${tid}.${k} is ${show(x)}, derived ${show(y)}`);
      }
      if (instant(h.since) !== w.since) {
        this.err(
          'R17',
          `${at}/since`,
          `${tid}.since is ${h.since}, derived ${iso(w.since)}`,
        );
      }
      if ((h.effective !== undefined) !== (w.effective !== undefined)) {
        this.err('R17', at, `${tid}: effective must be present exactly for grants`);
      } else if (w.effective !== undefined && sha256(this.canonEffective(h.effective)) !== this.d.key(w.effective)) {
        this.err('R17', `${at}/effective`, `${tid}.effective differs from the derived grant`);
      }
    }

    // R18: the first instant after as_of at which the derived term_states would differ. A term's
    // state changes only at its own candidate instants, so each term is followed on its own, up
    // to the earliest change found so far. While the status holds, `since` holds too.
    const all = this.events.length;
    let next: number | undefined;
    for (const tid of this.d.allTermIds()) {
      const now = want.get(tid);
      const cands = this.d.candidates(tid, all);
      for (let i = countAtOrBelow(cands, asOf); i < cands.length; i++) {
        const cand = cands[i]!;
        if (next !== undefined && cand >= next) break;
        this.work.spend(1);
        if (!this.sameState(this.d.evaluate(tid, cand, all), now)) {
          next = cand;
          break;
        }
      }
    }
    const got = state.freshness.next_change_at;
    if (next !== (got === undefined ? undefined : instant(got))) {
      this.err(
        'R18',
        got === undefined ? '/state/freshness' : '/state/freshness/next_change_at',
        `next_change_at is ${got ?? 'absent'}, derived ${next === undefined ? 'none' : iso(next)}`,
      );
    }
  }

  /** `canonEffective` of a grant the record gives, counted against the steps. */
  private canonEffective(effective: unknown): string {
    const text = canonEffective(effective);
    this.work.spendChars(text.length);
    return text;
  }

  /**
   * Whether two derived states agree in all but `since` (R18). `narrowed` needs no comparing:
   * the same version gives the same text, so equal effective grants are narrowed alike.
   */
  private sameState(a: DerivedState | undefined, b: DerivedState | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    if (a.status !== b.status || a.version !== b.version || a.end_reason !== b.end_reason) return false;
    if (a.effective === undefined || b.effective === undefined) return a.effective === b.effective;
    return a.effective === b.effective || this.d.key(a.effective) === this.d.key(b.effective);
  }

  // ---------- R19: disclosures ----------

  private checkDisclosures(): void {
    // Commitments in the attested part (the record without disclosures and the attestation), by
    // value. Members of a jwk are key material, never commitments.
    const found = new Map<string, Path[]>();
    const walk = (node: unknown, path: Path): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, [...path, i]));
      } else if (isPlainObject(node)) {
        const keys = Object.keys(node);
        if (keys.length === 1 && keys[0] === 'commitment') {
          const c = node['commitment'];
          // A disclosure is keyed by a string; any other value can only clash with an equal one.
          const key = typeof c === 'string' ? c : `\u0000${this.canon(c)}`;
          const paths = found.get(key);
          if (paths === undefined) found.set(key, [path]);
          else paths.push(path);
        }
        for (const [k, v] of Object.entries(node)) if (k !== 'jwk') walk(v, [...path, k]);
      }
    };
    for (const [k, v] of Object.entries(this.r)) {
      if (k !== 'disclosures' && k !== 'authority_attestation') walk(v, [k]);
    }
    for (const [d, paths] of found) {
      if (new Set(paths.map(fieldName)).size > 1) {
        this.err('R19', pointer(paths[1] ?? []), `commitment ${d} replaces fields of different names`);
      }
    }
    const disclosures = this.r.disclosures ?? {};
    for (const [d, disc] of Object.entries(disclosures)) {
      const at = `/disclosures/${pointerToken(d)}`;
      const paths = found.get(d);
      const first = paths?.[0];
      if (first === undefined) {
        this.err('R19', at, `disclosure ${d} matches no commitment`);
        continue;
      }
      // As `commitmentDigest`, counted against the steps: a disclosed value may be large.
      if (sha256(this.canon([disc.salt, disc.value])) !== d) {
        this.err(
          'R19',
          at,
          `disclosure ${d} does not match its commitment`,
        );
      }
      const name = fieldName(first);
      const val = disc.value;
      let ok: boolean;
      if (name === 'amount' || name === 'cap') ok = isMoney(val);
      else if (name === 'royalty_percent') ok = typeof val === 'string' && PERCENT.test(val);
      else ok = typeof val === 'string' && val.length > 0;
      if (!ok) this.err('R19', `${at}/value`, `disclosure ${d} has the wrong type for ${name}`);
    }

    // A compensation item's cap has the currency of its amount, once both are revealed.
    const reveal = (m: unknown): unknown => {
      if (!isPlainObject(m) || !('commitment' in m)) return m;
      const c = m['commitment'];
      return typeof c === 'string' && Object.hasOwn(disclosures, c) ? disclosures[c]?.value : undefined;
    };
    this.versions.forEach((v, i) =>
      v.compensation.forEach((x, j) => {
        const amount = reveal(x.amount);
        const cap = reveal(x.cap);
        if (isPlainObject(amount) && isPlainObject(cap) && !jsonEqual(amount['currency'], cap['currency'])) {
          this.err(
            'R19',
            `/agreements/${i}/agreement/compensation/${j}/cap`,
            `version ${v.version}: ${x.compensation_id} cap currency differs from amount`,
          );
        }
      }),
    );
  }

  // ---------- R20: attestation ----------

  private checkAttestation(): void {
    const a = this.r.authority_attestation;
    if (a.signer !== this.r.authority.id) {
      this.err(
        'R20',
        '/authority_attestation/signer',
        'attestation signer is not the serving authority',
      );
    }
    if (instant(a.signed_at) !== instant(this.r.state.as_of)) {
      this.err('R20', '/authority_attestation/signed_at', 'attestation signed_at differs from as_of');
    }
    const { disclosures: _disclosures, authority_attestation: _attestation, ...attested } = this.r;
    const stmt = this.statement('record_attestation', sha256(this.canon(attested)), a.signer, a.signed_at);
    for (const p of this.verify(a, stmt)) this.err('R20', '/authority_attestation', `attestation: ${p}`);
    this.keyChecks(a, 'attestation', '/authority_attestation', undefined);
  }
}

// ---------- helpers ----------

type Path = readonly (string | number)[];

/** Thrown when `LIMITS.problems` problems are found: the check stops there. */
class EnoughProblems extends Error {}

/**
 * The bindings recorded so far by `asset_bound` and `asset_unbound` events (R12, R16). A
 * binding is live once bound, unless it was ever unbound, even before it was bound.
 */
class LiveBindings {
  private readonly bound = new Set<string>();
  private readonly unbound = new Set<string>();
  /** Live binding ids by manifest label, and by each term id they name. */
  private readonly byLabel = new Map<string, Set<string>>();
  private readonly byTerm = new Map<string, Set<string>>();

  constructor(private readonly bindings: ReadonlyMap<string, AssetBinding>) {}

  wasBound(id: string): boolean {
    return this.bound.has(id);
  }

  wasUnbound(id: string): boolean {
    return this.unbound.has(id);
  }

  /** Whether a live binding other than `id` carries the manifest `label`. */
  clashes(id: string, label: string): boolean {
    const ids = this.byLabel.get(label);
    return ids !== undefined && ids.size > (ids.has(id) ? 1 : 0);
  }

  /** How many live bindings name the term. */
  naming(tid: string): number {
    return this.byTerm.get(tid)?.size ?? 0;
  }

  bind(id: string): void {
    const b = this.bindings.get(id);
    if (this.bound.has(id) || b === undefined) return;
    this.bound.add(id);
    if (this.unbound.has(id)) return;
    addTo(this.byLabel, b.c2pa.manifest_label, id);
    for (const tid of b.term_ids) addTo(this.byTerm, tid, id);
  }

  unbind(id: string): void {
    const b = this.bindings.get(id);
    if (this.unbound.has(id)) return;
    this.unbound.add(id);
    if (!this.bound.has(id) || b === undefined) return;
    this.byLabel.get(b.c2pa.manifest_label)?.delete(id);
    for (const tid of b.term_ids) this.byTerm.get(tid)?.delete(id);
  }
}

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  const ids = map.get(key);
  if (ids === undefined) map.set(key, new Set([id]));
  else ids.add(id);
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function pointer(path: Path): string {
  return path.map((p) => `/${pointerToken(String(p))}`).join('');
}

/** The member name a commitment stands for: the last name on its path. */
function fieldName(path: Path): string {
  const names = path.filter((p): p is string => typeof p === 'string');
  return names.at(-1) ?? '';
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A disclosed `amount` or `cap`: the schema's `money`, exactly `{value, currency}`. */
function isMoney(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const v = value['value'];
  const c = value['currency'];
  return (
    keys.length === 2 &&
    keys.includes('value') &&
    keys.includes('currency') &&
    typeof v === 'string' &&
    MONEY_VALUE.test(v) &&
    typeof c === 'string' &&
    CURRENCY.test(c)
  );
}

/** Two optional JSON values are equal (both absent counts as equal). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalize(a) === canonicalize(b);
}

/** How many values a narrowing lists. */
function valuesListed(n: Narrowing): number {
  let count = 1;
  for (const value of Object.values(n)) if (Array.isArray(value)) count += value.length;
  return count;
}

/** A version or party run 1, 2, … without gaps: what a dropped id that returns breaks (R5). */
function isRun(vs: readonly number[]): boolean {
  const first = vs[0];
  if (first === undefined) return true;
  return vs.every((x, i) => x === first + i);
}

/** Orders strings by code point, as sorting does in the profile's other implementations. */
function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done === true || q.done === true) return (p.done === true ? 0 : 1) - (q.done === true ? 0 : 1);
    const cp = p.value.codePointAt(0) ?? 0;
    const cq = q.value.codePointAt(0) ?? 0;
    if (cp !== cq) return cp - cq;
  }
}

function show(value: unknown): string {
  return value === undefined ? 'absent' : JSON.stringify(value);
}

/** The port a URI means when it names none, by scheme. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' };

/**
 * Whether two URIs have the same origin as RFC 6454 §4 computes it (R10): the scheme and
 * host without regard to ASCII case, and the port, the scheme's default when none is
 * written. A URI has a unique origin, equal to no other, unless its authority is just a host
 * name, an IPv4 address or a bracketed IPv6 address, with an optional port: userinfo (which
 * RFC 9110 §4.2.4 forbids in https URIs), percent-encoding, a backslash or any other
 * character could make a URL parser, such as the one `fetch` uses, find another host.
 */
function sameOrigin(a: string, b: string): boolean {
  const x = origin(a);
  return x !== undefined && x === origin(b);
}

function origin(uri: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]*))?(?:[/?#]|$)/.exec(uri);
  if (m === null) return undefined;
  const scheme = m[1]!.toLowerCase();
  const written = m[3];
  const port = written === undefined || written === '' ? (DEFAULT_PORTS[scheme] ?? '') : written.replace(/^0+(?=[0-9])/, '');
  return `${scheme}://${m[2]!.toLowerCase()}:${port}`;
}

/**
 * Standard base64 (RFC 4648 §4) as `x5c` holds it, decoded strictly: only the alphabet, then
 * exactly the `=` padding the length needs, and pad bits of zero (§3.5), so that each value
 * has one encoding. Undefined when the text is not such base64.
 */
function fromStrictBase64(text: string): Uint8Array | undefined {
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(text);
  if (m === null) return undefined;
  const rest = (m[1] ?? '').length % 4;
  const padding = (m[2] ?? '').length;
  const fits = (rest === 0 && padding === 0) || (rest === 2 && padding === 2) || (rest === 3 && padding === 1);
  if (!fits) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : undefined;
}

/**
 * What an `actor_signature` covers: the whole event without the signature for a hand-over
 * (`authority_transfer`), else the instruction members that are present (`event_instruction`).
 */
function signedPart(e: RecordEvent): [SigningStatement['statement'], unknown] {
  if (e.type === 'authority_transferred') {
    const { actor_signature: _signature, ...rest } = e;
    return ['authority_transfer', rest];
  }
  return ['event_instruction', Object.fromEntries(Object.entries(e).filter(([k]) => INSTRUCTION_MEMBERS.has(k)))];
}
