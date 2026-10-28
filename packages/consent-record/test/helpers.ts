/**
 * Test-side tools for the consent authority record tests. They follow spec/README.md
 * directly and use node:crypto, so the tests build and sign their inputs without the
 * verifier under test.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExternalCheck, Jwk, JwkSet, Problem, Resolvers, RuleId } from '../src/index';

export const REPO_ROOT_URL = new URL('../../../', import.meta.url);
export const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);
export const EXAMPLE_URL = new URL('spec/examples/digital-double.example.json', REPO_ROOT_URL);
export const VECTORS_URL = new URL('spec/test-vectors/', REPO_ROOT_URL);
export const CASES_URL = new URL('cases/', VECTORS_URL);

/**
 * A wall-clock bound in milliseconds, scaled for slower machines: shared CI runners take a few
 * times as long as a dev laptop. The step limit, not the clock, is what bounds a check.
 */
export function timeBound(ms: number): number {
  const ci = process.env.CI;
  return ci === undefined || ci === '' || ci === 'false' ? ms : 3 * ms;
}

export const RULE_IDS: readonly RuleId[] = [
  'schema',
  'R0',
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
  'limit',
  'internal',
];

/** R1 to R20: the rules that run only on a record that passes R0 and the schema. */
export const RULES_AFTER_SCHEMA = /^R([1-9]|1[0-9]|20)$/;

// The parts of a record these tests read or change. Everything else stays `unknown`.

export interface KeyBinding {
  method: string;
  did_url?: string;
  x5c?: string[];
  [member: string]: unknown;
}

export interface Signature {
  signer: string;
  signed_at: string;
  alg: string;
  jwk: Jwk;
  kid: string;
  key_binding?: KeyBinding;
  value: string;
  timestamp_token?: string;
  [member: string]: unknown;
}

export interface RecordEvent {
  seq: number;
  type: string;
  actor: string;
  recorded_at: string;
  received_at?: string;
  effective_at: string;
  keys_uri?: string;
  ref_digest?: string;
  actor_signature?: Signature;
  prev_digest: string | null;
  [member: string]: unknown;
}

export interface AgreementVersion {
  agreement: { version: number; [member: string]: unknown };
  agreement_digest: { alg: string; canonicalization: string; value: string };
  signatures: Signature[];
}

export interface ConsentRecord {
  profile: string;
  example?: boolean;
  record_uri: string;
  authority: { id: string; name: string; keys_uri: string; [member: string]: unknown };
  agreements: AgreementVersion[];
  state: {
    as_of: string;
    events: RecordEvent[];
    payments?: { payment_id: string; [member: string]: unknown }[];
    asset_bindings?: { binding_id: string; [member: string]: unknown }[];
    [member: string]: unknown;
  };
  disclosures?: Record<string, { salt: string; value: unknown }>;
  authority_attestation: Signature;
  [member: string]: unknown;
}

export function readExampleText(): string {
  return readFileSync(EXAMPLE_URL, 'utf8');
}

/** A fresh copy of the example record on every call. */
export function readExample(): ConsentRecord {
  return JSON.parse(readExampleText()) as ConsentRecord;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}

export function isUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 8785 for the values these tests build: JSON.stringify serializes strings and finite
 * numbers as ECMAScript does, and the default sort compares UTF-16 code units. It does not
 * reject lone surrogates or noncharacters; the tests never sign such values.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => jcs(item)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${jcs(object[name])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** `base64url(SHA-256(UTF-8(text)))`. */
export function sha256Base64url(text: string): string {
  return base64url(createHash('sha256').update(text, 'utf8').digest());
}

/** The digest of spec/README.md: `base64url(SHA-256(UTF-8(JCS(value))))`. */
export function digest(value: unknown): string {
  return sha256Base64url(jcs(value));
}

const THUMBPRINT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  AKP: ['alg', 'kty', 'pub'],
  EC: ['crv', 'kty', 'x', 'y'],
  OKP: ['crv', 'kty', 'x'],
  RSA: ['e', 'kty', 'n'],
};

/** RFC 7638 SHA-256 thumbprint. */
export function thumbprint(jwk: Jwk): string {
  const members = THUMBPRINT_MEMBERS[jwk.kty];
  if (members === undefined) throw new Error(`no thumbprint members for kty ${jwk.kty}`);
  const required: Record<string, unknown> = {};
  for (const name of members) required[name] = jwk[name];
  return digest(required);
}

// PKCS #8 prefix of an Ed25519 private key (RFC 8410); the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ExampleKey {
  readonly privateKey: KeyObject;
  readonly jwk: Jwk;
  readonly kid: string;
}

/**
 * The example's Ed25519 key for a signer (a `party_id` or an authority id): the seed is
 * SHA-256 of `grantmark example key: <signer>` (spec/README.md, "About the example").
 */
export function exampleKey(signer: string): ExampleKey {
  const seed = createHash('sha256').update(`grantmark example key: ${signer}`, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('Ed25519 public key without x');
  const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', x };
  return { privateKey, jwk, kid: thumbprint(jwk) };
}

export type StatementKind = 'agreement' | 'event_instruction' | 'authority_transfer' | 'record_attestation';

/**
 * Signs a signing statement with the example key of `signer`: a compact JWS with a
 * detached, unencoded payload, header `{alg, b64: false, crit: ["b64"], kid}`, over
 * `BASE64URL(header) || "." || JCS(statement)`.
 */
export function signStatement(
  record: Pick<ConsentRecord, 'profile' | 'record_uri'>,
  statement: StatementKind,
  statementDigest: string,
  signer: string,
  signedAt: string,
): Signature {
  const key = exampleKey(signer);
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: 'Ed25519', b64: false, crit: ['b64'], kid: key.kid }), 'utf8'),
  );
  const payload = jcs({
    profile: record.profile,
    record_uri: record.record_uri,
    statement,
    digest: statementDigest,
    signer,
    signed_at: signedAt,
  });
  const signature = sign(null, Buffer.from(`${header}.${payload}`, 'utf8'), key.privateKey);
  return {
    signer,
    signed_at: signedAt,
    alg: 'Ed25519',
    jwk: key.jwk,
    kid: key.kid,
    value: `${header}..${base64url(signature)}`,
  };
}

/**
 * The record without `disclosures` and without `authority_attestation`: what the attestation
 * covers.
 */
export function attestedPart(record: ConsentRecord): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...record };
  delete rest['disclosures'];
  delete rest['authority_attestation'];
  return rest;
}

/** Replaces `authority_attestation` with a fresh one by the same signer at the same time. */
export function attest(record: ConsentRecord): ConsentRecord {
  const { signer, signed_at: signedAt } = record.authority_attestation;
  record.authority_attestation = signStatement(
    record,
    'record_attestation',
    digest(attestedPart(record)),
    signer,
    signedAt,
  );
  return record;
}

const INSTRUCTION_MEMBERS = [
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
] as const;

/** The instruction members of an event that are present (spec/README.md, "Signing statements"). */
export function instructionMembers(event: RecordEvent): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  for (const name of INSTRUCTION_MEMBERS) {
    if (name in event) members[name] = event[name];
  }
  return members;
}

/** Sets every `prev_digest` to the digest of the event before it (R8). */
export function rechain(record: ConsentRecord): ConsentRecord {
  const events = record.state.events;
  for (let i = 1; i < events.length; i++) events[i]!.prev_digest = digest(events[i - 1]);
  return record;
}

export function readKeySets(): Record<string, JwkSet> {
  return JSON.parse(readFileSync(new URL('key-sets.json', VECTORS_URL), 'utf8')) as Record<
    string,
    JwkSet
  >;
}

export function keySetResolver(sets: Readonly<Record<string, JwkSet>>): NonNullable<Resolvers['keySet']> {
  return async (keysUri) => (Object.hasOwn(sets, keysUri) ? sets[keysUri] : undefined);
}

export interface SignatureAt {
  /** JSON Pointer to the signature object. */
  readonly at: string;
  readonly signature: Signature;
}

/** Every signature of a record with its JSON Pointer. */
export function signaturesOf(record: ConsentRecord): SignatureAt[] {
  const list: SignatureAt[] = [];
  record.agreements.forEach((version, i) => {
    version.signatures.forEach((signature, j) => {
      list.push({ at: `/agreements/${i}/signatures/${j}`, signature });
    });
  });
  record.state.events.forEach((event, k) => {
    if (event.actor_signature !== undefined) {
      list.push({ at: `/state/events/${k}/actor_signature`, signature: event.actor_signature });
    }
  });
  list.push({ at: '/authority_attestation', signature: record.authority_attestation });
  return list;
}

/**
 * The key set of an authority signer: `authority.keys_uri` for the serving authority, else
 * the `keys_uri` of the last `authority_transferred` event that this authority made.
 */
export function keysUriOf(record: ConsentRecord, signer: string): string {
  if (signer === record.authority.id) return record.authority.keys_uri;
  const handOver = record.state.events.findLast(
    (event) => event.type === 'authority_transferred' && event.actor === signer,
  );
  if (handOver?.keys_uri === undefined) throw new Error(`no key set for ${signer}`);
  return handOver.keys_uri;
}

export function isAuthorityId(signer: string): boolean {
  return signer.startsWith('https://');
}

/** The external checks the API contract asks for, built from the record. Sorted by `sortChecks`. */
export function expectedExternalChecks(record: ConsentRecord): ExternalCheck[] {
  const checks: ExternalCheck[] = [];
  for (const { at, signature } of signaturesOf(record)) {
    const { signer, kid, jwk } = signature;
    if (isAuthorityId(signer)) {
      checks.push({ kind: 'authority_key_set', at, signer, keysUri: keysUriOf(record, signer), kid, jwk });
    }
    const binding = signature.key_binding;
    if (binding?.method === 'did' && binding.did_url !== undefined) {
      checks.push({ kind: 'did', at, didUrl: binding.did_url, kid, jwk });
    }
    if (binding?.method === 'x509' && binding.x5c !== undefined) {
      checks.push({ kind: 'x509', at, x5c: binding.x5c, signedAt: signature.signed_at, kid, jwk });
    }
    if (signature.timestamp_token !== undefined) {
      checks.push({ kind: 'timestamp_token', at, token: signature.timestamp_token });
    }
  }
  return sortChecks(checks);
}

/** External checks in a fixed order (by `at`, then `kind`), since the API does not fix one. */
export function sortChecks(checks: readonly ExternalCheck[]): ExternalCheck[] {
  const key = (check: ExternalCheck) => `${check.at}\u0000${check.kind}`;
  return [...checks].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The keys behind the record's own `did` key bindings, by `did_url`: what a DID resolver would
 * return.
 */
export function didKeysOf(record: ConsentRecord): Map<string, Jwk> {
  const keys = new Map<string, Jwk>();
  for (const { signature } of signaturesOf(record)) {
    const binding = signature.key_binding;
    if (binding?.method !== 'did' || binding.did_url === undefined) continue;
    const known = keys.get(binding.did_url);
    if (known !== undefined && thumbprint(known) !== thumbprint(signature.jwk)) {
      throw new Error(`${binding.did_url} names two keys in this record`);
    }
    keys.set(binding.did_url, signature.jwk);
  }
  return keys;
}

export function didResolver(keys: ReadonlyMap<string, Jwk>): NonNullable<Resolvers['did']> {
  return async (didUrl) => keys.get(didUrl);
}

/** RFC 6901 syntax: empty, or `/`-separated tokens where `~` is followed by `0` or `1`. */
export function isJsonPointer(text: string): boolean {
  return text === '' || /^(\/([^/~]|~[01])*)+$/u.test(text);
}

export function formatProblems(problems: readonly Problem[]): string {
  if (problems.length === 0) return '(no problems)';
  return problems.map((p) => `${p.rule} ${p.at === '' ? '(record)' : p.at}: ${p.message}`).join('\n');
}

export interface VectorCase {
  readonly id: string;
  readonly file: string;
  readonly description: string;
  readonly expect: string;
}

export interface VectorIndex {
  readonly profile: string;
  readonly count: number;
  readonly cases: readonly VectorCase[];
}

export function readIndex(): VectorIndex {
  return JSON.parse(readFileSync(new URL('index.json', VECTORS_URL), 'utf8')) as VectorIndex;
}

/** A case file as raw bytes, in a plain Uint8Array (not a Buffer). */
export function vectorBytes(vector: VectorCase): Uint8Array {
  return new Uint8Array(readFileSync(new URL(vector.file, VECTORS_URL)));
}

export interface LoadedVector {
  readonly vector: VectorCase;
  readonly bytes: Uint8Array;
  readonly record: ConsentRecord;
}

/**
 * The first valid vector whose record matches; throws when none does, so a test cannot pass
 * vacuously.
 */
export function findValidVector(what: string, matches: (record: ConsentRecord) => boolean): LoadedVector {
  for (const vector of readIndex().cases) {
    if (vector.expect !== 'valid') continue;
    const bytes = vectorBytes(vector);
    const record = JSON.parse(decodeUtf8(bytes)) as ConsentRecord;
    if (matches(record)) return { vector, bytes, record };
  }
  throw new Error(`no valid test vector ${what}`);
}

/** The first case that expects `rule` and whose bytes match; throws when none does. */
export function findCase(rule: string, matches: (bytes: Uint8Array) => boolean = () => true): VectorCase {
  const found = readIndex().cases.find((vector) => vector.expect === rule && matches(vectorBytes(vector)));
  if (found === undefined) throw new Error(`no test vector expects ${rule}`);
  return found;
}
