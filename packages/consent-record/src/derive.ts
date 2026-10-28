/**
 * The derived state of a term (spec/README.md, "Deriving the state"): the version in force,
 * the effective grant after narrowings, the status at an instant, final states and `since`.
 *
 * Every query names how many of the record's events to judge by: a rule about an event's
 * time uses only the events before it in `seq` order (D21), `term_states` uses all of them.
 * Instants are milliseconds since the epoch, so equal instants written differently compare
 * equal. Every query spends steps of the check's `Work`.
 */
import { instant, isInstant, iso, sha256 } from './encoding';
import { canonicalize } from './jcs';
import { KEY_STEPS, Work } from './limits';
import {
  isInstruction,
  isVersionEvent,
  type Agreement,
  type Effective,
  type EndReason,
  type Grant,
  type InstructionEvent,
  type Narrowing,
  type NarrowedEvent,
  type Party,
  type RecordEvent,
  type ResumedEvent,
  type Scope,
  type Status,
  type Term,
} from './record';

/** `withdrawn` and `ended` are final (D20). */
export const FINAL: ReadonlySet<Status> = new Set<Status>(['withdrawn', 'ended']);

export interface DerivedState {
  readonly term_id: string;
  /** The version whose text applies: the version in force, or the last one that held the term. */
  readonly version: number;
  /** Grants only. Whether it differs from the text is `Derivation.narrowed`. */
  readonly effective?: Effective;
  readonly status: Status;
  /** `ended` only. */
  readonly end_reason?: EndReason;
  /** When the status began. `evaluate` sets it for a final state, `stateAt` always. */
  readonly since?: number;
}

/** A version event: when it takes effect, and which version. */
export interface VersionEffect {
  readonly at: number;
  readonly version: number;
}

/**
 * The instructions that name one term, in record order, with the instant each takes effect; the
 * first `n` count.
 */
interface Naming {
  readonly events: readonly InstructionEvent[];
  readonly at: readonly number[];
  readonly n: number;
}

const NO_NAMING: Naming = { events: [], at: [], n: 0 };

/** The record's events, indexed once. */
interface EventIndex {
  /** The version events by effect time, then version, then record order; each with its position. */
  readonly versions: readonly (VersionEffect & { readonly position: number })[];
  /** Per term, the instructions that name it, in record order, with their positions. */
  readonly instructions: ReadonlyMap<string, { readonly events: InstructionEvent[]; readonly at: number[]; readonly positions: number[] }>;
}

/** How many of the ascending `positions` are below `length`. */
export function countBelow(positions: readonly number[], length: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! < length) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Steps 1 and 2 at an instant, and the instructions for the term in effect then. */
interface TextAt {
  /** The version in force. */
  readonly k: number;
  /** The version whose text applies. */
  readonly last: number;
  readonly term: Term;
  /** In record order. */
  readonly mine: readonly InstructionEvent[];
}

/** The members of an agreement that the derivation and the R6 comparison read. */
type Text = Pick<Agreement, 'terms' | 'parties'>;

export class Derivation {
  /** Every version's agreement, in record order. Version n is `versions[n - 1]` (R1). */
  readonly versions: readonly Agreement[];
  /** The record's events, in record order. */
  private readonly events: readonly RecordEvent[];
  private readonly work: Work;
  private readonly termMaps = new WeakMap<Text, ReadonlyMap<string, Term>>();
  private readonly partyMaps = new WeakMap<Text, ReadonlyMap<string, Party>>();
  private indexed: EventIndex | undefined;
  private termIds: readonly string[] | undefined;
  /**
   * Results for all the events, and for the prefix asked about last. The checks judge one
   * event after another against the events before it, so older prefixes are not asked about
   * again, and keeping them would hold memory for every event.
   */
  private readonly full: Memo = newMemo();
  private last: { readonly length: number; readonly memo: Memo } | undefined;
  private readonly instants = new Map<string, number>();
  /** Per text: `instantForm`, remembered. */
  private readonly forms = new Map<string, string | undefined>();
  /** tid, then k: the last version up to `k` that holds the term (step 2). */
  private readonly holders = new Map<string, Map<number, number | undefined>>();
  /** Per grant text: its effective grant before any narrowing (step 3). */
  private readonly baselines = new WeakMap<Grant, Effective>();
  /**
   * Per grant text: the last list of narrowings applied to it, and the result. Checks that
   * look at many instants with the same narrowings in effect, such as asset bindings, share it.
   */
  private readonly lastNarrowed = new WeakMap<Grant, { readonly events: readonly NarrowedEvent[]; readonly effective: Effective }>();
  /** The key of each effective grant made so far. */
  private readonly keys = new WeakMap<Effective, string>();

  constructor(versions: readonly Agreement[], events: readonly RecordEvent[], work: Work = new Work()) {
    this.versions = versions;
    this.events = events;
    this.work = work;
  }

  version(n: number): Agreement | undefined {
    return this.versions[n - 1];
  }

  /** Terms by `term_id`. With duplicates (R3) the last one wins. */
  terms(v: Text): ReadonlyMap<string, Term> {
    let map = this.termMaps.get(v);
    if (map === undefined) {
      this.work.spend(v.terms.length);
      map = new Map(v.terms.map((t) => [t.term_id, t]));
      this.termMaps.set(v, map);
    }
    return map;
  }

  /** Parties by `party_id`. With duplicates (R3) the last one wins. */
  parties(v: Text): ReadonlyMap<string, Party> {
    let map = this.partyMaps.get(v);
    if (map === undefined) {
      this.work.spend(v.parties.length);
      map = new Map(v.parties.map((p) => [p.party_id, p]));
      this.partyMaps.set(v, map);
    }
    return map;
  }

  /** The terms of version `n`; none when the record has no such version. */
  termsOf(n: number): ReadonlyMap<string, Term> {
    const v = this.version(n);
    return v === undefined ? new Map() : this.terms(v);
  }

  /** The parties of version `n`; none when the record has no such version. */
  partiesOf(n: number): ReadonlyMap<string, Party> {
    const v = this.version(n);
    return v === undefined ? new Map() : this.parties(v);
  }

  /** Every term id, in the order the versions first name them. */
  allTermIds(): readonly string[] {
    if (this.termIds === undefined) {
      const seen = new Set<string>();
      for (const v of this.versions) {
        this.work.spend(v.terms.length);
        for (const t of v.terms) seen.add(t.term_id);
      }
      this.termIds = [...seen];
    }
    return this.termIds;
  }

  /**
   * The `issued` and `version_added` events among the first `length` events, by effect time and
   * then version.
   */
  versionEvents(length: number): readonly VersionEffect[] {
    const memo = this.memo(length);
    if (memo.versionEvents === undefined) {
      const all = this.index().versions;
      this.work.spend(all.length + 1);
      memo.versionEvents = length === this.events.length ? all : all.filter((x) => x.position < length);
    }
    return memo.versionEvents;
  }

  /** Step 1: the version in force at `t`, or undefined before version 1 takes effect. */
  versionAt(t: number, length: number): number | undefined {
    let k: number | undefined;
    const effects = this.versionEvents(length);
    this.work.spend(effects.length + 1);
    for (const { at, version } of effects) {
      if (at <= t && version <= this.versions.length) k = version;
    }
    return k;
  }

  /**
   * Steps 1 to 4 at `t`, before finality (step 5). Undefined when the term does not exist at
   * `t`: before the first version in force that holds it.
   */
  rawState(tid: string, t: number, length: number): DerivedState | undefined {
    const memo = this.memo(length);
    const key = `${t} ${tid}`;
    if (memo.raw.has(key)) return memo.raw.get(key);
    const st = this.computeRawState(tid, t, length);
    memo.raw.set(key, st);
    return st;
  }

  private computeRawState(tid: string, t: number, length: number): DerivedState | undefined {
    const at = this.textAt(tid, t, length);
    if (at === undefined) return undefined;
    // Step 3: the effective grant, narrowings applied in `seq` order.
    let effective: Effective | undefined;
    if (at.term.kind === 'grant') {
      const narrowings = at.mine.filter((e): e is NarrowedEvent => e.type === 'narrowed').sort((a, b) => a.seq - b.seq);
      effective = this.narrow(at.term, narrowings);
    }
    const base = { term_id: tid, version: at.last, ...(effective === undefined ? {} : { effective }) };
    return { ...base, ...this.status(at, t) };
  }

  /**
   * Steps 1 and 2 at `t`, and the instructions for the term in effect then. Undefined when
   * the term does not exist at `t`.
   */
  private textAt(tid: string, t: number, length: number): TextAt | undefined {
    const k = this.versionAt(t, length);
    if (k === undefined) return undefined;
    // Step 2: the text of the version in force, or of the last version that held the term.
    const last = this.lastHolder(tid, k);
    if (last === undefined) return undefined;
    // Undefined only when the versions are misnumbered, which R1 reports.
    const term = this.termsOf(last).get(tid);
    if (term === undefined) return undefined;
    const named = this.instructionsNaming(tid, length);
    this.work.spend(named.n + 1);
    const mine: InstructionEvent[] = [];
    for (let i = 0; i < named.n; i++) if (named.at[i]! <= t) mine.push(named.events[i]!);
    return { k, last, term, mine };
  }

  /**
   * Step 4 at `t`, in order of precedence. A grant's end is its effective `valid_until`: the
   * earliest of its text's and those of the narrowings in effect (step 3 keeps the earlier
   * end), which needs no effective grant.
   */
  private status({ k, last, term, mine }: TextAt, t: number): { readonly status: Status; readonly end_reason?: EndReason } {
    if (mine.some((e) => e.type === 'withdrawn')) return { status: 'withdrawn' };
    if (last !== k) return { status: 'ended', end_reason: 'dropped_by_version' };
    let end: number | undefined;
    let early = false;
    if (term.kind === 'grant') {
      const own = this.instant(term.valid_until);
      end = own;
      for (const e of mine) {
        if (e.type === 'narrowed' && e.narrowing.end_earlier !== undefined) end = Math.min(end, this.instant(e.narrowing.end_earlier));
      }
      early = end < own;
    } else if (term.valid_until !== undefined) {
      end = this.instant(term.valid_until);
    }
    if (end !== undefined && t >= end) return { status: 'ended', end_reason: early ? 'ended_early' : 'valid_until_reached' };
    if (t < this.instant(term.valid_from)) return { status: 'not_yet_valid' };
    const lifted = new Set(mine.filter((e): e is ResumedEvent => e.type === 'resumed').map((e) => e.ref_seq));
    if (mine.some((e) => e.type === 'suspended' && !lifted.has(e.seq))) return { status: 'suspended' };
    return { status: 'in_force' };
  }

  /**
   * Step 3: the grant after `narrowings`, in that order. Only the last list applied to each
   * grant text is kept: the lists in effect at different instants and prefixes need not extend
   * one another, so results kept per list would rarely be shared, and applying a list in one
   * pass costs no more than looking it up would. The last one serves checks that ask about
   * many instants with the same narrowings in effect, such as asset bindings.
   */
  private narrow(term: Grant, narrowings: readonly NarrowedEvent[]): Effective {
    const base = this.baseline(term);
    if (narrowings.length === 0) return base;
    const last = this.lastNarrowed.get(term);
    if (last !== undefined && sameEvents(last.events, narrowings)) return last.effective;
    const effective = applyNarrowings(
      base,
      narrowings.map((e) => e.narrowing),
      this.work,
      (text) => this.instant(text),
    );
    this.lastNarrowed.set(term, { events: narrowings, effective });
    return effective;
  }

  /** A grant's text as an effective grant, made once per grant text. */
  private baseline(term: Grant): Effective {
    let base = this.baselines.get(term);
    if (base === undefined) this.baselines.set(term, (base = baselineEffective(term)));
    return base;
  }

  /**
   * Whether a state's effective grant differs from its text (`narrowed`). Asked only where it
   * is read, since it compares keys, which costs far more than making the grant.
   */
  narrowed(st: DerivedState): boolean {
    if (st.effective === undefined) return false;
    // The text the state was derived from: `version` is the version whose text applies.
    const term = this.termsOf(st.version).get(st.term_id);
    if (term === undefined || term.kind !== 'grant') return false;
    const base = this.baseline(term);
    return st.effective !== base && this.key(st.effective) !== this.key(base);
  }

  /**
   * The SHA-256 of an effective grant's comparable text (`canonEffective`), made once per
   * grant object: grants are equal exactly when their keys are. Keeping the key rather than
   * the text keeps memory small when a record narrows a large grant many times.
   */
  key(effective: Effective): string {
    let key = this.keys.get(effective);
    if (key === undefined) {
      const text = canonEffective(effective, (value) => this.instantForm(value));
      this.work.spend(
        KEY_STEPS.perValue * valuesIn(effective) + KEY_STEPS.perKey + Math.ceil(text.length / KEY_STEPS.charsPerStep),
      );
      key = sha256(text);
      this.keys.set(effective, key);
    }
    return key;
  }

  /** The last version up to `k`, in record order, that holds the term (step 2). */
  private lastHolder(tid: string, k: number): number | undefined {
    let byK = this.holders.get(tid);
    if (byK === undefined) this.holders.set(tid, (byK = new Map()));
    if (byK.has(k)) return byK.get(k);
    this.work.spend(this.versions.length);
    let last: number | undefined;
    for (const v of this.versions) if (v.version <= k && this.terms(v).has(tid)) last = v.version;
    byK.set(k, last);
    return last;
  }

  /** The instructions among the first `length` events that name the term. */
  private instructionsNaming(tid: string, length: number): Naming {
    const all = this.index().instructions.get(tid);
    if (all === undefined) return NO_NAMING;
    const n = length >= this.events.length ? all.events.length : countBelow(all.positions, length);
    return { events: all.events, at: all.at, n };
  }

  /** The version events and, per term, the instructions that name it. */
  private index(): EventIndex {
    if (this.indexed === undefined) {
      const versions: (VersionEffect & { position: number })[] = [];
      const instructions = new Map<string, { events: InstructionEvent[]; at: number[]; positions: number[] }>();
      this.work.spend(this.events.length);
      this.events.forEach((e, i) => {
        if (isVersionEvent(e)) versions.push({ at: this.instant(e.effective_at), version: e.version, position: i });
        if (!isInstruction(e)) return;
        const at = this.instant(e.effective_at);
        this.work.spend(e.term_ids.length);
        for (const id of new Set(e.term_ids)) {
          let list = instructions.get(id);
          if (list === undefined) instructions.set(id, (list = { events: [], at: [], positions: [] }));
          list.events.push(e);
          list.at.push(at);
          list.positions.push(i);
        }
      });
      // A stable sort: equal effect times and versions keep record order.
      versions.sort((a, b) => a.at - b.at || a.version - b.version);
      this.indexed = { versions, instructions };
    }
    return this.indexed;
  }

  /**
   * Every instant at which the raw state of a term can change (step 5), ascending: the
   * `effective_at` of each version event and of each instruction that names the term, the
   * term's `valid_from` and `valid_until` in every version, and the `end_earlier` of each
   * narrowing of it. Steps 1 to 4 read nothing else that depends on time.
   */
  candidates(tid: string, length: number): readonly number[] {
    const memo = this.memo(length);
    let out = memo.candidates.get(tid);
    if (out === undefined) {
      const set = new Set(this.versionEvents(length).map((x) => x.at));
      const named = this.instructionsNaming(tid, length);
      this.work.spend(set.size + named.n + this.versions.length);
      for (let i = 0; i < named.n; i++) {
        const e = named.events[i]!;
        set.add(named.at[i]!);
        if (e.type === 'narrowed' && e.narrowing.end_earlier !== undefined) set.add(this.instant(e.narrowing.end_earlier));
      }
      for (const v of this.versions) {
        const term = this.terms(v).get(tid);
        if (term === undefined) continue;
        set.add(this.instant(term.valid_from));
        if (term.valid_until !== undefined) set.add(this.instant(term.valid_until));
      }
      out = [...set].sort((a, b) => a - b);
      this.work.spend(out.length);
      memo.candidates.set(tid, out);
    }
    return out;
  }

  /**
   * The state at `t` with finality (step 5): the earliest instant at or before `t` at which
   * the term is withdrawn or ended decides, and `since` is that instant. Otherwise the raw
   * state at `t`, without `since`.
   */
  evaluate(tid: string, t: number, length: number): DerivedState | undefined {
    const at = this.finalAt(tid, length);
    if (at !== undefined && at <= t) return this.finalState(tid, at, length);
    return this.rawState(tid, t, length);
  }

  /** The status `evaluate` gives, without making the effective grant. */
  statusAt(tid: string, t: number, length: number): Status | undefined {
    const at = this.finalAt(tid, length);
    if (at !== undefined && at <= t) return this.finalState(tid, at, length).status;
    const memo = this.memo(length);
    const key = `${t} ${tid}`;
    if (memo.raw.has(key)) return memo.raw.get(key)?.status;
    if (memo.status.has(key)) return memo.status.get(key);
    const text = this.textAt(tid, t, length);
    const status = text === undefined ? undefined : this.status(text, t).status;
    memo.status.set(key, status);
    return status;
  }

  /** The first candidate instant with a final raw state, among the first `length` events. */
  private finalAt(tid: string, length: number): number | undefined {
    const memo = this.memo(length);
    if (!memo.finalAt.has(tid)) memo.finalAt.set(tid, this.firstFinalInstant(tid, length));
    return memo.finalAt.get(tid);
  }

  /**
   * The state at the earliest candidate instant at which the raw state is withdrawn or ended.
   * No earlier candidate is final, so it is also the first final one up to any later instant.
   */
  private finalState(tid: string, at: number, length: number): DerivedState & { readonly since: number } {
    const memo = this.memo(length);
    let found = memo.final.get(tid);
    if (found === undefined) {
      const st = this.rawState(tid, at, length);
      // Both read the same steps; if they ever disagreed, a problem must show it, not a pass.
      if (st === undefined || !FINAL.has(st.status)) throw new Error(`derivation of ${tid} disagrees with itself at ${iso(at)}`);
      found = { ...st, since: at };
      memo.final.set(tid, found);
    }
    return found;
  }

  /**
   * The first candidate instant at which the raw state is withdrawn or ended. Between two
   * instants that have version events, the version in force, and so the text, is fixed.
   * There the state is final from the first of: a withdrawal in effect, the text's
   * `valid_until`, and, for a grant, a narrowing in effect whose `end_earlier` has passed
   * (step 3 keeps the earlier end). Each of these instants is a candidate. A version in force
   * that no longer holds the term ends it when it takes effect.
   */
  private firstFinalInstant(tid: string, length: number): number | undefined {
    let withdrawal = Infinity;
    let narrowedEnd = Infinity;
    const named = this.instructionsNaming(tid, length);
    for (let i = 0; i < named.n; i++) {
      const e = named.events[i]!;
      const at = named.at[i]!;
      if (e.type === 'withdrawn') withdrawal = Math.min(withdrawal, at);
      if (e.type === 'narrowed' && e.narrowing.end_earlier !== undefined) {
        narrowedEnd = Math.min(narrowedEnd, Math.max(at, this.instant(e.narrowing.end_earlier)));
      }
    }
    const effects = this.versionEvents(length);
    this.work.spend(named.n + effects.length + 1);
    let k: number | undefined;
    for (let i = 0; i < effects.length; ) {
      const start = effects[i]!.at;
      for (; i < effects.length && effects[i]!.at === start; i++) {
        const { version } = effects[i]!;
        if (version <= this.versions.length) k = version;
      }
      const next = i < effects.length ? effects[i]!.at : Infinity;
      // The same order of checks as `computeRawState`.
      if (k === undefined) continue;
      const last = this.lastHolder(tid, k);
      if (last === undefined) continue;
      const term = this.termsOf(last).get(tid);
      if (term === undefined) continue;
      if (last !== k) return start;
      let first = withdrawal;
      if (term.kind === 'grant') first = Math.min(first, this.instant(term.valid_until), narrowedEnd);
      else if (term.valid_until !== undefined) first = Math.min(first, this.instant(term.valid_until));
      const at = Math.max(start, first);
      if (at < next) return at;
    }
    return undefined;
  }

  /** `evaluate` with `since` (step 6): how far back the status has held without a break. */
  stateAt(tid: string, t: number, length: number): (DerivedState & { readonly since: number }) | undefined {
    const now = this.evaluate(tid, t, length);
    if (now === undefined) return undefined;
    if (now.since !== undefined) return { ...now, since: now.since };
    const cands = this.candidates(tid, length);
    let since: number | undefined;
    for (let i = countAtOrBelow(cands, t) - 1; i >= 0; i--) {
      this.work.spend(1);
      const then = this.statusAt(tid, cands[i]!, length);
      if (then === undefined || then !== now.status) break;
      since = cands[i];
    }
    return { ...now, since: since ?? t };
  }

  isFinal(tid: string, t: number, length: number): boolean {
    const status = this.statusAt(tid, t, length);
    return status !== undefined && FINAL.has(status);
  }

  private memo(length: number): Memo {
    if (length >= this.events.length) return this.full;
    if (this.last?.length !== length) this.last = { length, memo: newMemo() };
    return this.last.memo;
  }

  /** `instant`, remembered: the same few date-times are read many times. */
  instant(text: string): number {
    let ms = this.instants.get(text);
    if (ms === undefined) {
      ms = instant(text);
      this.instants.set(text, ms);
    }
    return ms;
  }

  private instantForm(text: string): string | undefined {
    if (this.forms.has(text)) return this.forms.get(text);
    const form = isInstant(text) ? iso(this.instant(text)) : undefined;
    this.forms.set(text, form);
    return form;
  }
}

interface Memo {
  versionEvents?: readonly VersionEffect[];
  /** tid → candidate instants, ascending. */
  readonly candidates: Map<string, readonly number[]>;
  /** `${t} ${tid}` → raw state. */
  readonly raw: Map<string, DerivedState | undefined>;
  /** `${t} ${tid}` → its status, where only the status was asked for. */
  readonly status: Map<string, Status | undefined>;
  /** tid → the first candidate instant with a final raw state, if any. */
  readonly finalAt: Map<string, number | undefined>;
  /** tid → the raw state at that instant, once asked for. */
  readonly final: Map<string, DerivedState & { readonly since: number }>;
}

function newMemo(): Memo {
  return { candidates: new Map(), raw: new Map(), status: new Map(), finalAt: new Map(), final: new Map() };
}

/** The same events in the same order. */
function sameEvents(a: readonly RecordEvent[], b: readonly RecordEvent[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}

/** How many of the ascending `values` are at most `t`. */
export function countAtOrBelow(values: readonly number[], t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A grant's text as an effective grant, before any narrowing. */
export function baselineEffective(term: Grant): Effective {
  const eff: Effective = {
    uses: term.uses,
    scope: term.scope,
    licensees: term.licensees,
    valid_from: term.valid_from,
    valid_until: term.valid_until,
  };
  return term.consent_domain === 'identity' ? { ...eff, identity_attributes: term.identity_attributes ?? [] } : eff;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** How many values an effective grant lists: the work of copying or comparing it. */
export function valuesIn(eff: Effective): number {
  const s = eff.scope;
  return (
    1 +
    eff.uses.length +
    (eff.identity_attributes?.length ?? 0) +
    eff.licensees.length +
    s.media_types.length +
    s.channels.length +
    s.territories.include.length +
    (s.territories.exclude?.length ?? 0) +
    (s.prohibited_contexts?.length ?? 0) +
    (s.named_works?.length ?? 0) +
    (s.sublicensing?.to?.length ?? 0)
  );
}

/**
 * Narrowings applied to an effective grant one after another (step 3, the table of
 * operations), in one pass: the work grows with the narrowings plus the grant, not with
 * their product. Returns a new value. `instantOf` reads a date-time, as `instant` does.
 */
export function applyNarrowings(
  eff: Effective,
  narrowings: readonly Narrowing[],
  work: Work,
  instantOf: (text: string) => number = instant,
): Effective {
  work.spend(valuesIn(eff) + narrowings.length);
  const scope: Mutable<Scope> = { ...eff.scope };
  const out: Mutable<Effective> = { ...eff, scope };
  // Members are set in the order applying one narrowing at a time sets them.
  // A list that narrowings only remove from ends up as the list without every value removed.
  const removed = {
    uses: new Set<string>(),
    identity: new Set<string>(),
    media: new Set<string>(),
    channels: new Set<string>(),
    licensees: new Set<string>(),
    include: new Set<string>(),
  };
  // `["WORLD"]` stays as it is, since the schema allows WORLD only alone: a removal from it
  // adds exclusions.
  const world = isWorld(eff.scope.territories.include);
  let territories = false;
  let exclude: string[] | undefined;
  let excluded: Set<string> | undefined;
  let contexts: string[] | undefined;
  let prohibited: Set<string> | undefined;
  // Sublicensing ends forbidden once a narrowing forbids it or removes the last party of its
  // `to` list.
  const sub = eff.scope.sublicensing;
  let forbidden = false;
  let subRemoved = false;
  const toRemoved = new Set<string>();
  const toCounts = new Map<string, number>();
  for (const x of sub?.to ?? []) toCounts.set(x, (toCounts.get(x) ?? 0) + 1);
  let toLeft = sub?.to?.length ?? 0;
  let named = scope.named_works;
  // `out.valid_until` as an instant.
  let until = instantOf(eff.valid_until);
  for (const n of narrowings) {
    removeAll(removed.uses, n.remove_uses, work);
    removeAll(removed.identity, n.remove_identity_attributes, work);
    removeAll(removed.media, n.remove_media_types, work);
    removeAll(removed.channels, n.remove_channels, work);
    removeAll(removed.licensees, n.remove_licensees, work);
    if (n.remove_territories) {
      territories = true;
      if (world) {
        if (exclude === undefined) {
          exclude = [...(eff.scope.territories.exclude ?? [])];
          excluded = new Set(exclude);
        }
        addAll(exclude, excluded!, n.remove_territories, work);
      } else {
        removeAll(removed.include, n.remove_territories, work);
      }
    }
    if (n.add_prohibited_contexts) {
      if (contexts === undefined) {
        contexts = [...(eff.scope.prohibited_contexts ?? [])];
        prohibited = new Set(contexts);
        scope.prohibited_contexts = contexts;
      }
      addAll(contexts, prohibited!, n.add_prohibited_contexts, work);
    }
    if (sub !== undefined && !forbidden) {
      if (n.forbid_sublicensing !== undefined) {
        forbidden = true;
      } else if (n.remove_sublicensees && sub.allowed) {
        // Without a `to` list only on a later version's text: R13 let the narrowing name only
        // parties of a `to` list.
        work.spend(n.remove_sublicensees.length);
        for (const x of n.remove_sublicensees) {
          if (!toRemoved.has(x) && toCounts.has(x)) toLeft -= toCounts.get(x)!;
          toRemoved.add(x);
        }
        subRemoved = true;
        if (sub.to === undefined || toLeft === 0) forbidden = true;
      }
    }
    if (n.restrict_named_works) {
      const keep = new Set(n.restrict_named_works);
      work.spend(keep.size + (named?.length ?? 0));
      named = named === undefined ? [...n.restrict_named_works] : named.filter((w) => keep.has(w));
      scope.named_works = named;
    }
    if (n.lower_max_assets !== undefined) scope.max_assets = Math.min(scope.max_assets ?? n.lower_max_assets, n.lower_max_assets);
    if (n.end_earlier !== undefined) {
      const end = instantOf(n.end_earlier);
      if (end < until) {
        until = end;
        out.valid_until = n.end_earlier;
      }
    }
  }
  out.uses = left(eff.uses, removed.uses);
  if (out.identity_attributes) out.identity_attributes = left(out.identity_attributes, removed.identity);
  scope.media_types = left(scope.media_types, removed.media);
  scope.channels = left(scope.channels, removed.channels);
  out.licensees = left(eff.licensees, removed.licensees);
  if (territories) {
    const t = eff.scope.territories;
    scope.territories = world ? { ...t, exclude: exclude! } : { ...t, include: left(t.include, removed.include) };
  }
  if (forbidden) scope.sublicensing = { allowed: false };
  else if (subRemoved) scope.sublicensing = { ...sub!, to: left(sub!.to!, toRemoved) };
  return out;
}

/** A list that narrowings only remove from: the values to remove, gathered. */
function removeAll(into: Set<string>, values: readonly string[] | undefined, work: Work): void {
  if (values === undefined) return;
  work.spend(values.length);
  for (const x of values) into.add(x);
}

/** A list that narrowings add to: each one adds the values the list does not hold yet. */
function addAll(list: string[], held: Set<string>, values: readonly string[], work: Work): void {
  work.spend(values.length);
  // Filtered first, as the operation reads the list before adding: a value listed twice is
  // added twice.
  const fresh = values.filter((x) => !held.has(x));
  for (const x of fresh) {
    list.push(x);
    held.add(x);
  }
}

/** The list without the values gone; the list itself when none are. */
function left(list: readonly string[], gone: ReadonlySet<string>): readonly string[] {
  return gone.size === 0 ? list : list.filter((x) => !gone.has(x));
}

/** Territories `["WORLD"]`, which a removal narrows by adding exclusions. */
export function isWorld(include: readonly string[]): boolean {
  return include.length === 1 && include[0] === 'WORLD';
}

/**
 * Comparable text for an effective grant (step 3): arrays as sets, and `valid_from` and
 * `valid_until`, its only instants, as instants. Other strings compare as written, even
 * when they look like dates. `formOf` gives a date-time's form, as `instantForm` does.
 */
export function canonEffective(eff: unknown, formOf: (text: string) => string | undefined = instantForm): string {
  return canonicalize(comparable(eff, formOf));
}

/**
 * A date-time as `canonEffective` writes it: the instant in one spelling. Undefined for other
 * text.
 */
export function instantForm(text: string): string | undefined {
  return isInstant(text) ? iso(instant(text)) : undefined;
}

const INSTANT_MEMBERS = ['valid_from', 'valid_until'] as const;

function comparable(eff: unknown, formOf: (text: string) => string | undefined): unknown {
  const out = asSets(eff);
  if (out === null || typeof out !== 'object' || Array.isArray(out)) return out;
  const fields = out as Record<string, unknown>;
  for (const name of INSTANT_MEMBERS) {
    const value = fields[name];
    const form = typeof value === 'string' ? formOf(value) : undefined;
    if (form !== undefined) fields[name] = form;
  }
  return fields;
}

function asSets(node: unknown): unknown {
  if (Array.isArray(node)) {
    // A list of strings, the only kind an effective grant holds, sorts as it is. Any other list
    // sorts by its items' canonical texts, inside one more array: it never equals a list of
    // strings.
    if (node.every((v) => typeof v === 'string')) return [...node].sort();
    return [node.map((v) => canonicalize(asSets(v))).sort()];
  }
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, asSets(v)]));
  }
  return node;
}
