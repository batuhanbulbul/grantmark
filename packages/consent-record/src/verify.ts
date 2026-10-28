/**
 * The offline check plus the external checks that resolvers can run: authority key sets
 * (verifier step 4 of spec/README.md) and DID resolution (step 3). A check that cannot run
 * is reported in `unchecked`, never passed silently.
 */
import { checkRecord, checkRecordText } from './check';
import { thumbprint, verificationKeyProblem } from './jws';
import { LIMITS } from './limits';
import type { ExternalCheck, Jwk, JwkSet, Problem, Resolvers, Unchecked, VerifyResult } from './types';

export async function verifyRecord(input: unknown, resolvers: Resolvers = {}): Promise<VerifyResult> {
  const checked = typeof input === 'string' || input instanceof Uint8Array ? checkRecordText(input) : checkRecord(input);
  const problems: Problem[] = [...checked.problems];
  const unchecked: Unchecked[] = [];
  const cache: Cache = { keySets: new Map(), dids: new Map(), asked: 0 };
  const external = checked.external;
  const outcomes = new Array<Outcome>(external.length);
  for (const i of resolutionOrder(external)) {
    try {
      outcomes[i] = await run(external[i]!, resolvers, cache);
    } catch (error) {
      outcomes[i] = { unchecked: `resolver failed: ${(error as Error).message}` };
    }
  }
  external.forEach((check, i) => {
    const outcome = outcomes[i]!;
    if (outcome.problem && problems.length < LIMITS.problems) problems.push(outcome.problem);
    if (outcome.unchecked) unchecked.push({ check, reason: outcome.unchecked });
  });
  const valid = problems.length === 0;
  return { view: checked.view, example: checked.example, valid, complete: valid && unchecked.length === 0, problems, unchecked };
}

/**
 * Each key set and DID is asked for, and its answer read, once per record, however many
 * signatures name it: a key set as the thumbprints it lists, a DID as its key's. `asked`
 * counts the calls, at most `LIMITS.resolutions`.
 */
interface Cache {
  readonly keySets: Map<string, Promise<ReadonlySet<string> | undefined>>;
  readonly dids: Map<string, Promise<DidKey | undefined>>;
  asked: number;
}

/** The key a DID URL resolves to: why it may not verify signatures, or its thumbprint. */
interface DidKey {
  readonly misuse?: string;
  readonly thumbprint?: string;
}

interface Outcome {
  readonly problem?: Problem;
  readonly unchecked?: string;
}

async function run(
  check: ExternalCheck,
  resolvers: Resolvers,
  cache: Cache,
): Promise<Outcome> {
  switch (check.kind) {
    case 'authority_key_set': {
      if (!resolvers.keySet) return { unchecked: 'no key set resolver' };
      if (check.keysUri === '') return { unchecked: `no key set is known for ${check.signer}` };
      let pending = cache.keySets.get(check.keysUri);
      if (!pending) {
        if (!ask(cache)) return { unchecked: TOO_MANY };
        pending = listedKeys(() => resolvers.keySet!(check.keysUri));
        cache.keySets.set(check.keysUri, pending);
      }
      const listed = await pending;
      if (!listed) return { unchecked: `key set at ${check.keysUri} is not available` };
      if (listed.has(check.kid)) return {};
      return {
        problem: {
          rule: check.at === '/authority_attestation' ? 'R20' : 'R7',
          at: check.at,
          message: `key ${check.kid} is not in the key set of ${check.signer} at ${check.keysUri}`,
        },
      };
    }
    case 'did': {
      if (!resolvers.did) return { unchecked: 'no DID resolver' };
      let pending = cache.dids.get(check.didUrl);
      if (!pending) {
        if (!ask(cache)) return { unchecked: TOO_MANY };
        pending = didKey(() => resolvers.did!(check.didUrl));
        cache.dids.set(check.didUrl, pending);
      }
      const key = await pending;
      if (!key) return { unchecked: `${check.didUrl} did not resolve` };
      if (key.misuse !== undefined) {
        return { problem: { rule: 'R7', at: check.at, message: `${check.didUrl} resolves to a key that may not verify signatures: ${key.misuse}` } };
      }
      if (key.thumbprint === check.kid) return {};
      return { problem: { rule: 'R7', at: check.at, message: `${check.didUrl} resolves to another key than the signature's` } };
    }
    case 'x509':
      return { unchecked: 'X.509 certificate chains are not checked in this version' };
    case 'timestamp_token':
      return { unchecked: 'RFC 3161 time-stamp tokens are not checked in this version' };
  }
}

/**
 * The order to run external checks in, as indexes: the serving authority's key set first, then
 * the other key sets, then the rest. A party chooses its DID URLs, and they must not use up
 * `LIMITS.resolutions` before the key sets that tie the record to its authorities.
 */
function resolutionOrder(checks: readonly ExternalCheck[]): number[] {
  const rank = (check: ExternalCheck): number =>
    check.kind !== 'authority_key_set' ? 2 : check.at === '/authority_attestation' ? 0 : 1;
  return [...checks.keys()].sort((a, b) => rank(checks[a]!) - rank(checks[b]!));
}

const TOO_MANY = `the record names more than ${LIMITS.resolutions} key sets and DID URLs`;

/** Counts one more resolver call; false when `LIMITS.resolutions` calls were made already. */
function ask(cache: Cache): boolean {
  if (cache.asked >= LIMITS.resolutions) return false;
  cache.asked += 1;
  return true;
}

/**
 * The thumbprints a key set lists: of each key that has no other `kid` and may verify
 * signatures (a public key whose `use` and `key_ops` allow it). `undefined` when the answer is
 * no object, which breaks the resolver's contract and says nothing about the record. The
 * resolver is called in here, so that a call that throws is kept as a failed answer too.
 */
async function listedKeys(call: () => Promise<JwkSet | undefined>): Promise<ReadonlySet<string> | undefined> {
  const set: unknown = await call();
  if (typeof set !== 'object' || set === null) return undefined;
  const listed = new Set<string>();
  const keys: unknown = (set as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return listed;
  for (const key of keys as unknown[]) {
    if (key === null || typeof key !== 'object') continue;
    const own = (key as Record<string, unknown>)['kid'];
    if (own !== undefined && typeof own !== 'string') continue;
    const print = thumbprintOf(key as Jwk);
    if (print === undefined || (own !== undefined && own !== print)) continue;
    if (verificationKeyProblem(key as Jwk) === undefined) listed.add(print);
  }
  return listed;
}

/** As for a key set: the key the DID names must also be one that may verify signatures. */
async function didKey(call: () => Promise<Jwk | undefined>): Promise<DidKey | undefined> {
  const jwk: unknown = await call();
  if (typeof jwk !== 'object' || jwk === null) return undefined;
  const misuse = verificationKeyProblem(jwk as Jwk);
  if (misuse !== undefined) return { misuse };
  const print = thumbprintOf(jwk as Jwk);
  return print === undefined ? {} : { thumbprint: print };
}

function thumbprintOf(jwk: Jwk): string | undefined {
  try {
    return thumbprint(jwk);
  } catch {
    return undefined;
  }
}
