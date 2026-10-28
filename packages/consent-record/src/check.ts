/**
 * The offline check: R0, the JSON Schema, then R1–R20 (src/checker.ts). It also lists the
 * checks that need data from outside the record (spec/README.md, "Signing statements",
 * verifier steps 3 and 4), which src/verify.ts runs when it has resolvers.
 */
import { checkRules } from './checker';
import { parseText, valueProblems } from './ijson';
import { LimitError } from './limits';
import { schemaProblems } from './schema';
import type { CheckResult, ExternalCheck, Jwk, Problem } from './types';

type Json = Record<string, unknown>;

export function checkRecord(record: unknown): CheckResult {
  let view: CheckResult['view'] = 'public';
  let example = false;
  let problems: Problem[];
  let external: ExternalCheck[] = [];
  try {
    // Inside the try: a record given as a value may have members whose getters throw.
    view = isObject(record) && 'disclosures' in record ? 'full' : 'public';
    example = isObject(record) && record['example'] === true;
    problems = valueProblems(record);
    if (problems.length === 0) problems = schemaProblems(record);
    if (problems.length === 0) problems = checkRules(record);
    if (problems.length === 0) external = externalChecks(record as Json);
  } catch (error) {
    problems =
      error instanceof LimitError
        ? [{ rule: 'limit', at: '', message: error.message }]
        : [{ rule: 'internal', at: '', message: `verifier failure: ${(error as Error).message}` }];
    external = [];
  }
  return { view, example, problems, external };
}

export function checkRecordText(text: string | Uint8Array): CheckResult {
  const refused = (problem: Problem): CheckResult => ({ view: 'public', example: false, problems: [problem], external: [] });
  if (typeof text !== 'string' && !(text instanceof Uint8Array)) return refused({ rule: 'R0', at: '', message: 'the record is not text' });
  let parsed: ReturnType<typeof parseText>;
  try {
    parsed = parseText(text);
  } catch (error) {
    return refused({ rule: 'internal', at: '', message: `verifier failure: ${(error as Error).message}` });
  }
  if (!parsed.ok) return { view: 'public', example: false, problems: parsed.problems, external: [] };
  return checkRecord(parsed.value);
}

export function toPublicView<T>(record: T): T {
  if (!isObject(record)) return record;
  // A shallow copy: a deep one would recurse through a record of any depth before any check.
  const { disclosures: _, ...rest } = record;
  return rest as T;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every signature of a schema-valid record, with where it sits. */
function signatures(record: Json): { at: string; sig: Json }[] {
  const out: { at: string; sig: Json }[] = [];
  const agreements = record['agreements'] as Json[];
  agreements.forEach((item, i) => {
    (item['signatures'] as Json[]).forEach((sig, j) => out.push({ at: `/agreements/${i}/signatures/${j}`, sig }));
  });
  const events = (record['state'] as Json)['events'] as Json[];
  events.forEach((event, k) => {
    const sig = event['actor_signature'];
    if (isObject(sig)) out.push({ at: `/state/events/${k}/actor_signature`, sig });
  });
  out.push({ at: '/authority_attestation', sig: record['authority_attestation'] as Json });
  return out;
}

/**
 * The one key set of each authority that signs: the serving authority's `authority.keys_uri`,
 * and for an authority that handed the record over, the `keys_uri` of its last
 * `authority_transferred` event (events are in `seq` order).
 */
function keySetsByAuthority(record: Json): Map<string, string> {
  const map = new Map<string, string>();
  const events = (record['state'] as Json)['events'] as Json[];
  for (const e of events) {
    if (e['type'] === 'authority_transferred' && typeof e['actor'] === 'string' && typeof e['keys_uri'] === 'string') {
      map.set(e['actor'], e['keys_uri']);
    }
  }
  const authority = record['authority'] as Json;
  map.set(authority['id'] as string, authority['keys_uri'] as string);
  return map;
}

function externalChecks(record: Json): ExternalCheck[] {
  const keySets = keySetsByAuthority(record);
  const out: ExternalCheck[] = [];
  for (const { at, sig } of signatures(record)) {
    const signer = sig['signer'] as string;
    const kid = sig['kid'] as string;
    const jwk = sig['jwk'] as Jwk;
    if (signer.startsWith('https://')) {
      out.push({ kind: 'authority_key_set', at, signer, keysUri: keySets.get(signer) ?? '', kid, jwk });
    }
    const binding = sig['key_binding'];
    if (isObject(binding) && binding['method'] === 'did') {
      out.push({ kind: 'did', at, didUrl: binding['did_url'] as string, kid, jwk });
    } else if (isObject(binding) && binding['method'] === 'x509') {
      out.push({ kind: 'x509', at, x5c: binding['x5c'] as string[], signedAt: sig['signed_at'] as string, kid, jwk });
    }
    if (typeof sig['timestamp_token'] === 'string') {
      out.push({ kind: 'timestamp_token', at, token: sig['timestamp_token'] });
    }
  }
  return out;
}
