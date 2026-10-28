import { describe, expect, it, vi } from 'vitest';
import { checkRecord, checkRecordText, toPublicView, verifyRecord } from '../src/index';
import type { CheckResult, ExternalCheck, Jwk, JwkSet, Resolvers, VerifyResult } from '../src/index';
import {
  attest,
  didKeysOf,
  didResolver,
  digest,
  exampleKey,
  findValidVector,
  formatProblems,
  instructionMembers,
  keySetResolver,
  readExample,
  readExampleText,
  readKeySets,
  rechain,
  signStatement,
  signaturesOf,
  sortChecks,
  type ConsentRecord,
} from './helpers';

const AUTHORITY = 'https://authority.example';
const AUTHORITY_KEYS = 'https://authority.example/.well-known/jwks.json';
const SUCCESSOR = 'https://successor-authority.example';
const PARTICIPANT = 'p-elin';
const PARTICIPANT_DID = 'did:example:elin-marsh#key-1';
// The example's signatures by the participant, whose key binding is `did`.
const PARTICIPANT_SIGNATURES = ['/agreements/0/signatures/0', '/agreements/1/signatures/0', '/state/events/5/actor_signature'];
// A syntactically valid RFC 3161 token placeholder (DER of an empty SEQUENCE, base64).
const TOKEN = 'MAA=';

const keySets = readKeySets();
const keySet = keySetResolver(keySets);
const participantKey = exampleKey(PARTICIPANT);
const authorityKey = exampleKey(AUTHORITY);
const participantDid = didResolver(new Map([[PARTICIPANT_DID, participantKey.jwk]]));

const unit = (codeUnit: number) => String.fromCharCode(codeUnit);
const char = (codePoint: number) => String.fromCodePoint(codePoint);

function rules(result: CheckResult | VerifyResult): string[] {
  return result.problems.map((problem) => problem.rule);
}

function expectConsistent(result: VerifyResult): void {
  expect(result.valid).toBe(result.problems.length === 0);
  expect(result.complete).toBe(result.valid && result.unchecked.length === 0);
  for (const entry of result.unchecked) {
    expect(typeof entry.reason).toBe('string');
    expect(entry.reason.length).toBeGreaterThan(0);
  }
}

/** Key sets from key-sets.json with one key set replaced. */
function keySetsWith(keysUri: string, keys: readonly Jwk[]): NonNullable<Resolvers['keySet']> {
  return keySetResolver({ ...keySets, [keysUri]: { keys } });
}

/** Key sets from key-sets.json without the key `kid` in the set at `keysUri`. */
function keySetsWithout(keysUri: string, kid: string): NonNullable<Resolvers['keySet']> {
  const set = keySets[keysUri];
  if (set === undefined) throw new Error(`key-sets.json has no ${keysUri}`);
  const keys = set.keys.filter((key) => key['kid'] !== kid);
  expect(keys.length).toBe(set.keys.length - 1);
  return keySetsWith(keysUri, keys);
}

/**
 * The example with an `actor_signature` by the authority on its `asset_bound` event, chain and
 * attestation renewed.
 */
function exampleWithSignedBinding(): { record: ConsentRecord; at: string } {
  const record = readExample();
  const k = record.state.events.findIndex((event) => event.type === 'asset_bound');
  const event = record.state.events[k]!;
  expect(event.actor).toBe(AUTHORITY);
  event.actor_signature = signStatement(
    record,
    'event_instruction',
    digest(instructionMembers(event)),
    event.actor,
    event.received_at ?? event.recorded_at,
  );
  return { record: attest(rechain(record)), at: `/state/events/${k}/actor_signature` };
}

/** Text with raw bytes in place of `marker`. */
function textWithBytes(text: string, marker: string, raw: readonly number[]): Uint8Array {
  const index = text.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  const encoder = new TextEncoder();
  return Uint8Array.from([
    ...encoder.encode(text.slice(0, index)),
    ...raw,
    ...encoder.encode(text.slice(index + marker.length)),
  ]);
}

function deepObject(depth: number): unknown {
  let value: unknown = {};
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
}

function deepArray(depth: number): unknown {
  let value: unknown = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe('the example record', () => {
  it('has no problem in the full view', () => {
    const result = checkRecord(readExample());
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.view).toBe('full');
    expect(result.example).toBe(true);
  });

  it('has no problem in the public view', () => {
    const result = checkRecord(toPublicView(readExample()));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.view).toBe('public');
    expect(result.example).toBe(true);
  });

  it('gives the same result for the parsed record, its text and its UTF-8 bytes', () => {
    const text = readExampleText();
    const parsed = checkRecord(readExample());
    for (const result of [checkRecordText(text), checkRecordText(new TextEncoder().encode(text))]) {
      expect(result.problems).toEqual(parsed.problems);
      expect(result.view).toBe(parsed.view);
      expect(result.example).toBe(parsed.example);
      expect(sortChecks(result.external)).toEqual(sortChecks(parsed.external));
    }
  });

  it('does not depend on whitespace or member order in the text', () => {
    const record = readExample();
    expect(checkRecordText(JSON.stringify(record, null, 2)).problems).toEqual([]);
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    expect(checkRecordText(JSON.stringify(reordered)).problems).toEqual([]);
  });

  it('lists the authority key set check and the DID checks, and nothing for authority_verified keys', () => {
    const record = readExample();
    const expected: ExternalCheck[] = [
      {
        kind: 'authority_key_set',
        at: '/authority_attestation',
        signer: AUTHORITY,
        keysUri: AUTHORITY_KEYS,
        kid: authorityKey.kid,
        jwk: authorityKey.jwk,
      },
      ...PARTICIPANT_SIGNATURES.map(
        (at): ExternalCheck => ({
          kind: 'did',
          at,
          didUrl: PARTICIPANT_DID,
          kid: participantKey.kid,
          jwk: participantKey.jwk,
        }),
      ),
    ];
    expect(sortChecks(checkRecord(record).external)).toEqual(sortChecks(expected));
    expect(sortChecks(checkRecord(toPublicView(record)).external)).toEqual(sortChecks(expected));
  });
});

describe('toPublicView', () => {
  it('returns a new record without disclosures and leaves its input unchanged', () => {
    const record = readExample();
    const before = structuredClone(record);
    const view: unknown = toPublicView(record);
    expect(view).not.toBe(record);
    expect(Object.hasOwn(view as object, 'disclosures')).toBe(false);
    const { disclosures, ...rest } = before;
    expect(disclosures).toBeDefined();
    expect(view).toEqual(rest);
    expect(record).toEqual(before);
  });

  it('returns a new object for a record that has no disclosures', () => {
    const first: unknown = toPublicView(readExample());
    const second: unknown = toPublicView(first as ConsentRecord);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('view and example', () => {
  it('reports the full view only when disclosures is present', () => {
    expect(checkRecord(readExample()).view).toBe('full');
    expect(checkRecord(toPublicView(readExample())).view).toBe('public');
  });

  it('reports example: false for a record with example: false', () => {
    const record = readExample();
    record.example = false;
    const result = checkRecord(attest(record));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.example).toBe(false);
  });

  it('reports example: false for a record without the member', () => {
    const record = readExample();
    delete record.example;
    const result = checkRecord(attest(record));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.example).toBe(false);
  });
});

describe('the authority attestation', () => {
  it('covers the record: a changed authority name is R20', () => {
    const record = readExample();
    record.authority.name = 'Another Consent Authority (fictional)';
    const result = checkRecord(record);
    expect(rules(result)).toContain('R20');
    expect(result.external).toEqual([]);
  });

  it('verifies again once the authority signs the changed record', () => {
    const record = readExample();
    record.authority.name = 'Another Consent Authority (fictional)';
    const result = checkRecord(attest(record));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
  });

  it('is computed over UTF-8: a name with a supplementary character verifies once signed', () => {
    const record = readExample();
    record.authority.name = `Authority ${char(0x1f600)} ${char(0xe9)}${char(0x20ac)}`;
    const result = checkRecordText(JSON.stringify(attest(record)));
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
  });

  it('does not cover disclosures: the full view and the public view verify with one attestation', () => {
    const record = readExample();
    expect(checkRecord(record).problems).toEqual([]);
    expect(checkRecord(toPublicView(record)).problems).toEqual([]);
  });
});

describe('external checks', () => {
  it('names the serving authority key set and the key set of an authority that handed the record over', () => {
    const { record, bytes } = findValidVector('with a hand-over', (r) =>
      r.state.events.some((event) => event.type === 'authority_transferred'),
    );
    const k = record.state.events.findIndex((event) => event.type === 'authority_transferred');
    const handOver = record.state.events[k]!;
    const signature = handOver.actor_signature!;
    expect(handOver.keys_uri).toBeDefined();
    expect(handOver.keys_uri).not.toBe(record.authority.keys_uri);

    const result = checkRecordText(bytes);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.external).toContainEqual({
      kind: 'authority_key_set',
      at: '/authority_attestation',
      signer: record.authority.id,
      keysUri: record.authority.keys_uri,
      kid: record.authority_attestation.kid,
      jwk: record.authority_attestation.jwk,
    });
    expect(result.external).toContainEqual({
      kind: 'authority_key_set',
      at: `/state/events/${k}/actor_signature`,
      signer: handOver.actor,
      keysUri: handOver.keys_uri,
      kid: signature.kid,
      jwk: signature.jwk,
    });
  });

  it('names the serving authority key set for an authority signature on another event', () => {
    const { record, at } = exampleWithSignedBinding();
    const result = checkRecord(record);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.external).toContainEqual({
      kind: 'authority_key_set',
      at,
      signer: AUTHORITY,
      keysUri: AUTHORITY_KEYS,
      kid: authorityKey.kid,
      jwk: authorityKey.jwk,
    });
  });

  it('lists an x509 check for an x509 key binding', () => {
    const { record, bytes } = findValidVector('with an x509 key binding', (r) =>
      signaturesOf(r).some(({ signature }) => signature.key_binding?.method === 'x509'),
    );
    const result = checkRecordText(bytes);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    const x509 = signaturesOf(record).filter(({ signature }) => signature.key_binding?.method === 'x509');
    for (const { at, signature } of x509) {
      expect(result.external).toContainEqual({
        kind: 'x509',
        at,
        x5c: signature.key_binding!.x5c,
        signedAt: signature.signed_at,
        kid: signature.kid,
        jwk: signature.jwk,
      });
    }
    expect(result.external.filter((check) => check.kind === 'x509')).toHaveLength(x509.length);
  });

  it('lists a timestamp_token check for a token on the attestation', () => {
    const record = readExample();
    // The attestation is outside what it signs, so a token can be added without signing again.
    record.authority_attestation.timestamp_token = TOKEN;
    const result = checkRecord(record);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.external).toContainEqual({ kind: 'timestamp_token', at: '/authority_attestation', token: TOKEN });
    expect(result.external.filter((check) => check.at === '/authority_attestation')).toHaveLength(2);
  });

  it('lists nothing when the record has a problem', () => {
    const record = readExample();
    // A token added to a recorded signature changes the agreements item that ref_digest covers.
    record.agreements[0]!.signatures[0]!.timestamp_token = TOKEN;
    const result = checkRecord(record);
    expect(rules(result)).toContain('R9');
    expect(result.external).toEqual([]);
  });
});

describe('malformed input', () => {
  const notRecords: [string, unknown][] = [
    ['null', null],
    ['zero', 0],
    ['a number', 42],
    ['a fraction', -1.5],
    ['true', true],
    ['false', false],
    ['an empty string', ''],
    ['a string', 'not a record'],
    ['an empty array', []],
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['an object with only a profile', { profile: readExample().profile }],
  ];

  it.each(notRecords)('checkRecord reports a schema problem for %s', (_name, input) => {
    const result = checkRecord(input);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((problem) => problem.rule === 'schema'), formatProblems(result.problems)).toBe(true);
    expect(result.external).toEqual([]);
  });

  it.each(notRecords)('checkRecordText reports a schema problem for %s as JSON text', (_name, input) => {
    const result = checkRecordText(JSON.stringify(input));
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((problem) => problem.rule === 'schema'), formatProblems(result.problems)).toBe(true);
    expect(result.external).toEqual([]);
  });

  const notJson: [string, unknown][] = [
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a function', () => 1],
    ['a symbol', Symbol('record')],
    ['a bigint', 10n],
    ['a Date', new Date(0)],
    ['a Map', new Map([['profile', 'x']])],
    ['a record whose profile is undefined', { ...readExample(), profile: undefined }],
    ['a record with a bigint seq', { ...readExample(), state: { ...readExample().state, events: [{ seq: 1n }] } }],
  ];

  it.each(notJson)('checkRecord does not throw for %s', (_name, input) => {
    const result = checkRecord(input);
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) expect(['schema', 'R0']).toContain(problem.rule);
    expect(result.external).toEqual([]);
  });

  it.each([
    ['an object nested 100000 deep', deepObject(100_000)],
    ['an array nested 100000 deep', deepArray(100_000)],
    ['a record with a value nested 100000 deep', { ...readExample(), example: deepObject(100_000) }],
  ])('checkRecord does not throw for %s', (_name, input) => {
    const result = checkRecord(input);
    expect(result.problems.length).toBeGreaterThan(0);
    // The verifier may give up on such input (`limit`, `internal`); it must still report it.
    for (const problem of result.problems) expect(['schema', 'R0', 'limit', 'internal']).toContain(problem.rule);
    expect(result.external).toEqual([]);
  });

  const badTexts: [string, string | Uint8Array][] = [
    ['an empty string', ''],
    ['whitespace', ' \n\t'],
    ['words', 'not json'],
    ['an unclosed object', '{"profile":'],
    ['two values', '{"a":1}{"b":2}'],
    ['a trailing comma', '{"a":1,}'],
    ['single quotes', "{'a':1}"],
    ['NaN', 'NaN'],
    ['a comment', '{} // comment'],
    ['no bytes', new Uint8Array(0)],
    ['a byte that is never UTF-8', Uint8Array.from([0xff])],
    ['a truncated UTF-8 sequence', Uint8Array.from([0x22, 0xc3, 0x22])],
    ['an overlong encoding', Uint8Array.from([0x22, 0xc0, 0xaf, 0x22])],
    ['an encoded surrogate', Uint8Array.from([0x22, 0xed, 0xa0, 0x80, 0x22])],
  ];

  it.each(badTexts)('checkRecordText does not throw for %s', (_name, text) => {
    const result = checkRecordText(text);
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) expect(['schema', 'R0']).toContain(problem.rule);
    expect(result.external).toEqual([]);
  });

  it.each([
    ['arrays nested 100000 deep', `${'['.repeat(100_000)}${']'.repeat(100_000)}`],
    ['objects nested 100000 deep', `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`],
  ])('checkRecordText does not throw for %s', (_name, text) => {
    const result = checkRecordText(text);
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) expect(['schema', 'R0', 'limit', 'internal']).toContain(problem.rule);
    expect(result.external).toEqual([]);
  });

  it.each([...notRecords, ...notJson, ...badTexts])('verifyRecord resolves for %s', async (_name, input) => {
    const keySetSpy = vi.fn(keySet);
    const result = await verifyRecord(input, { keySet: keySetSpy, did: participantDid });
    expectConsistent(result);
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unchecked).toEqual([]);
    expect(keySetSpy).not.toHaveBeenCalled();
  });
});

describe('a wrong type in a deep field', () => {
  const field = (object: unknown, name: string, value: unknown): void => {
    (object as Record<string, unknown>)[name] = value;
  };
  const mutations: [string, (record: ConsentRecord) => void][] = [
    ['a party role list that is a number', (r) => field((r.agreements[0]!.agreement['parties'] as unknown[])[0], 'roles', 5)],
    ['term_ids that is a string', (r) => field(r.state.events[5], 'term_ids', 't-likeness-campaign')],
    ['a jwk that is null', (r) => field(r.agreements[0]!.signatures[0], 'jwk', null)],
    ['a signature value that is an object', (r) => field(r.agreements[1]!.signatures[0], 'value', {})],
    ['term_states that is null', (r) => field(r.state, 'term_states', null)],
    ['events that is a number', (r) => field(r.state, 'events', 7)],
    ['an agreement that is null', (r) => field(r.agreements[1], 'agreement', null)],
    ['agreements that is an object', (r) => field(r, 'agreements', {})],
    ['state that is an array', (r) => field(r, 'state', [])],
    ['an attestation that is a string', (r) => field(r, 'authority_attestation', 'signed')],
    ['disclosures that is an array', (r) => field(r, 'disclosures', [])],
    ['a seq above 2^53 - 1', (r) => field(r.state.events[0], 'seq', 2 ** 60)],
    ['an impossible date (30 February)', (r) => field(r.state.events[0], 'recorded_at', '2026-02-30T00:00:00Z')],
    ['a narrowing that is a list', (r) => field(r.state.events[5], 'narrowing', ['remove_territories'])],
  ];

  it.each(mutations)('reports only schema problems for %s', (_name, mutate) => {
    const record = readExample();
    mutate(record);
    for (const result of [checkRecord(record), checkRecordText(JSON.stringify(record))]) {
      expect(result.problems.length).toBeGreaterThan(0);
      // R1 to R20 run only on a record that passes R0 and the schema.
      expect(result.problems.every((problem) => problem.rule === 'schema'), formatProblems(result.problems)).toBe(
        true,
      );
      expect(result.external).toEqual([]);
    }
  });
});

describe('R0', () => {
  const MARK = 'MARK-0000';

  function exampleWith(name: string): string {
    const record = readExample();
    record.authority.name = name;
    return JSON.stringify(record);
  }

  it('finds a lone surrogate in a parsed value', () => {
    const record = readExample();
    record.authority.name = `Authority ${unit(0xd800)}`;
    expect(rules(checkRecord(record))).toContain('R0');
  });

  it('finds a noncharacter in a parsed value and in a member name', () => {
    const value = readExample();
    value.authority.name = `Authority ${char(0xfffe)}`;
    expect(rules(checkRecord(value))).toContain('R0');
    const name = readExample();
    name.authority[`x${char(0x10ffff)}`] = 'value';
    expect(rules(checkRecord(name))).toContain('R0');
  });

  it.each([
    ['a lone surrogate written as an escape', '\\ud800'],
    ['a lone low surrogate written as an escape', '\\udc00'],
    ['a reversed surrogate pair written as escapes', '\\ude00\\ud83d'],
    ['a noncharacter written as an escape', '\\ufdd0'],
    ['a noncharacter written as escapes of its surrogate pair', '\\ud83f\\udffe'],
  ])('finds %s in the text', (_name, escape) => {
    const text = exampleWith(MARK).replace(MARK, escape);
    expect(rules(checkRecordText(text))).toContain('R0');
  });

  it('accepts a surrogate pair written as escapes', () => {
    const record = readExample();
    record.authority.name = `Authority ${char(0x1f600)}`;
    const text = JSON.stringify(attest(record)).replace(char(0x1f600), '\\ud83d\\ude00');
    const result = checkRecordText(text);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
  });

  it.each([
    ['a lone surrogate', unit(0xdbff)],
    ['a noncharacter', char(0x1fffe)],
  ])('finds %s written directly in a string given as text', (_name, raw) => {
    const text = exampleWith(MARK).replace(MARK, raw);
    expect(rules(checkRecordText(text))).toContain('R0');
  });

  it.each([
    ['a byte that is never UTF-8', [0xff]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['an overlong encoding', [0xc1, 0x81]],
    ['a truncated sequence', [0xe2, 0x82]],
  ])('finds %s in the bytes', (_name, raw) => {
    expect(rules(checkRecordText(textWithBytes(exampleWith(MARK), MARK, raw)))).toContain('R0');
  });

  it('finds a duplicate member name in the text', () => {
    const text = readExampleText();
    expect(rules(checkRecordText(text.replace('{', '{"example":true,')))).toContain('R0');
  });

  it('finds a duplicate member name that only an escape hides', () => {
    const text = readExampleText();
    expect(rules(checkRecordText(text.replace('{', '{"\\u0065xample":true,')))).toContain('R0');
  });

  it('finds a duplicate member name in a nested object', () => {
    const text = JSON.stringify(readExample()).replace('"authority":{', '"authority":{"name":"Other",');
    expect(rules(checkRecordText(text))).toContain('R0');
  });
});

describe('verifyRecord', () => {
  it('lists every external check as unchecked without resolvers', async () => {
    const record = readExample();
    const result = await verifyRecord(record);
    expectConsistent(result);
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.view).toBe('full');
    expect(result.example).toBe(true);
    expect(sortChecks(result.unchecked.map((entry) => entry.check))).toEqual(sortChecks(checkRecord(record).external));
  });

  it('takes a parsed record, a string or bytes', async () => {
    const text = readExampleText();
    const results = await Promise.all([
      verifyRecord(readExample(), { keySet }),
      verifyRecord(text, { keySet }),
      verifyRecord(new TextEncoder().encode(text), { keySet }),
    ]);
    for (const result of results) {
      expectConsistent(result);
      expect(result.valid).toBe(true);
      expect(result.view).toBe('full');
      expect(sortChecks(result.unchecked.map((entry) => entry.check))).toEqual(
        sortChecks(results[0]!.unchecked.map((entry) => entry.check)),
      );
    }
  });

  it('checks the public view as well', async () => {
    const result = await verifyRecord(toPublicView(readExample()), { keySet, did: participantDid });
    expectConsistent(result);
    expect(result.view).toBe('public');
    expect(result.complete).toBe(true);
  });

  it('is complete when the key set and DID checks run and pass', async () => {
    const result = await verifyRecord(readExample(), { keySet, did: participantDid });
    expectConsistent(result);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(true);
  });

  it('asks the resolvers for keys_uri and did_url', async () => {
    const keySetSpy = vi.fn(keySet);
    const didSpy = vi.fn(participantDid);
    await verifyRecord(readExample(), { keySet: keySetSpy, did: didSpy });
    expect(keySetSpy).toHaveBeenCalledWith(AUTHORITY_KEYS);
    for (const [keysUri] of keySetSpy.mock.calls) expect(keysUri).toBe(AUTHORITY_KEYS);
    expect(didSpy).toHaveBeenCalledWith(PARTICIPANT_DID);
    for (const [didUrl] of didSpy.mock.calls) expect(didUrl).toBe(PARTICIPANT_DID);
  });

  it('runs only the checks it has a resolver for', async () => {
    const onlyKeys = await verifyRecord(readExample(), { keySet });
    expectConsistent(onlyKeys);
    expect(onlyKeys.valid).toBe(true);
    expect(onlyKeys.complete).toBe(false);
    expect(onlyKeys.unchecked.map((entry) => entry.check.kind)).toEqual(['did', 'did', 'did']);

    const onlyDid = await verifyRecord(readExample(), { did: participantDid });
    expectConsistent(onlyDid);
    expect(onlyDid.valid).toBe(true);
    expect(onlyDid.unchecked.map((entry) => entry.check.kind)).toEqual(['authority_key_set']);
  });

  describe('authority key sets', () => {
    const attestationKid = authorityKey.kid;

    it('reports R20 when the serving key set lacks the attestation key', async () => {
      const result = await verifyRecord(readExample(), {
        keySet: keySetsWithout(AUTHORITY_KEYS, attestationKid),
        did: participantDid,
      });
      expectConsistent(result);
      expect(result.problems).toContainEqual(expect.objectContaining({ rule: 'R20', at: '/authority_attestation' }));
      expect(result.valid).toBe(false);
      expect(result.complete).toBe(false);
    });

    it('reports R20 when the key set lists the kid with another key', async () => {
      const other = exampleKey(SUCCESSOR).jwk;
      const result = await verifyRecord(readExample(), {
        keySet: keySetsWith(AUTHORITY_KEYS, [{ ...other, kid: attestationKid }]),
        did: participantDid,
      });
      expectConsistent(result);
      expect(result.problems).toContainEqual(expect.objectContaining({ rule: 'R20', at: '/authority_attestation' }));
    });

    it('reports R20 when the key set holds the key under another kid', async () => {
      const result = await verifyRecord(readExample(), {
        keySet: keySetsWith(AUTHORITY_KEYS, [{ ...authorityKey.jwk, kid: 'attestation-key-2026' }]),
        did: participantDid,
      });
      expectConsistent(result);
      expect(result.problems).toContainEqual(expect.objectContaining({ rule: 'R20', at: '/authority_attestation' }));
    });

    it('accepts a listed key with members beyond the thumbprint', async () => {
      const result = await verifyRecord(readExample(), {
        keySet: keySetsWith(AUTHORITY_KEYS, [
          { ...authorityKey.jwk, kid: attestationKid, use: 'sig', alg: 'Ed25519', key_ops: ['verify'] },
        ]),
        did: participantDid,
      });
      expectConsistent(result);
      expect(result.problems, formatProblems(result.problems)).toEqual([]);
      expect(result.complete).toBe(true);
    });

    it('reports R7, not R20, for an authority signature on an event', async () => {
      const { record, at } = exampleWithSignedBinding();
      const passing = await verifyRecord(record, { keySet, did: participantDid });
      expectConsistent(passing);
      expect(passing.problems, formatProblems(passing.problems)).toEqual([]);
      expect(passing.complete).toBe(true);

      const failing = await verifyRecord(record, {
        keySet: keySetsWithout(AUTHORITY_KEYS, attestationKid),
        did: participantDid,
      });
      expectConsistent(failing);
      expect(failing.problems).toContainEqual(expect.objectContaining({ rule: 'R7', at }));
      expect(failing.problems).toContainEqual(expect.objectContaining({ rule: 'R20', at: '/authority_attestation' }));
    });

    it("checks a hand-over signature against the transferring authority's key set", async () => {
      const { record, bytes } = findValidVector('with a hand-over', (r) =>
        r.state.events.some((event) => event.type === 'authority_transferred'),
      );
      const k = record.state.events.findIndex((event) => event.type === 'authority_transferred');
      const handOver = record.state.events[k]!;
      const at = `/state/events/${k}/actor_signature`;
      const did = didResolver(didKeysOf(record));

      const passing = await verifyRecord(bytes, { keySet, did });
      expectConsistent(passing);
      expect(passing.problems, formatProblems(passing.problems)).toEqual([]);

      const failing = await verifyRecord(bytes, {
        keySet: keySetsWithout(handOver.keys_uri!, handOver.actor_signature!.kid),
        did,
      });
      expectConsistent(failing);
      expect(failing.problems).toContainEqual(expect.objectContaining({ rule: 'R7', at }));
      expect(failing.problems.filter((problem) => problem.at === '/authority_attestation')).toEqual([]);
      expect(failing.valid).toBe(false);
    });

    it.each([
      ['returns undefined', async () => undefined],
      [
        'throws',
        () => {
          throw new Error('network down');
        },
      ],
      [
        'rejects',
        async () => {
          throw new Error('network down');
        },
      ],
    ] as [string, NonNullable<Resolvers['keySet']>][])(
      'leaves the check unchecked when the resolver %s',
      async (_name, resolver) => {
        const result = await verifyRecord(readExample(), { keySet: resolver, did: participantDid });
        expectConsistent(result);
        expect(result.problems).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.complete).toBe(false);
        expect(result.unchecked.map((entry) => entry.check)).toEqual([
          expect.objectContaining({ kind: 'authority_key_set', at: '/authority_attestation' }),
        ]);
      },
    );

    it.each([
      ['null', null],
      ['keys that is a string', { keys: 'none' }],
      ['keys with odd entries', { keys: [null, 5, {}, { kty: 'OKP' }] }],
      ['an empty object', {}],
    ])('does not reject or pass on a malformed key set: %s', async (_name, set) => {
      const result = await verifyRecord(readExample(), {
        keySet: async () => set as unknown as JwkSet,
        did: participantDid,
      });
      expectConsistent(result);
      expect(result.complete).toBe(false);
    });
  });

  describe('DIDs', () => {
    it('reports R7 when the DID resolves to another key', async () => {
      const other = exampleKey('p-twin-studio').jwk;
      const result = await verifyRecord(readExample(), {
        keySet,
        did: didResolver(new Map([[PARTICIPANT_DID, other]])),
      });
      expectConsistent(result);
      for (const at of PARTICIPANT_SIGNATURES) {
        expect(result.problems).toContainEqual(expect.objectContaining({ rule: 'R7', at }));
      }
      expect(result.valid).toBe(false);
    });

    it('compares keys by thumbprint, ignoring other members', async () => {
      const resolved: Jwk = { ...participantKey.jwk, kid: 'key-1', use: 'sig', alg: 'Ed25519' };
      const result = await verifyRecord(readExample(), {
        keySet,
        did: didResolver(new Map([[PARTICIPANT_DID, resolved]])),
      });
      expectConsistent(result);
      expect(result.problems, formatProblems(result.problems)).toEqual([]);
      expect(result.complete).toBe(true);
    });

    it('resolves each did_url on its own', async () => {
      const { bytes, record } = findValidVector('with two DIDs', (r) => didKeysOf(r).size > 1);
      const keys = didKeysOf(record);
      const passing = await verifyRecord(bytes, { keySet, did: didResolver(keys) });
      expectConsistent(passing);
      expect(passing.problems, formatProblems(passing.problems)).toEqual([]);

      const urls = [...keys.keys()];
      const swapped = new Map(urls.map((url, i) => [url, keys.get(urls[(i + 1) % urls.length]!)!]));
      const failing = await verifyRecord(bytes, { keySet, did: didResolver(swapped) });
      expectConsistent(failing);
      for (const { at, signature } of signaturesOf(record)) {
        if (signature.key_binding?.method !== 'did') continue;
        expect(failing.problems).toContainEqual(expect.objectContaining({ rule: 'R7', at }));
      }
    });

    it.each([
      ['returns undefined', async () => undefined],
      [
        'throws',
        () => {
          throw new Error('no DID method');
        },
      ],
      [
        'rejects',
        async () => {
          throw new Error('no DID method');
        },
      ],
    ] as [string, NonNullable<Resolvers['did']>][])('leaves the check unchecked when the resolver %s', async (_name, did) => {
      const result = await verifyRecord(readExample(), { keySet, did });
      expectConsistent(result);
      expect(result.problems).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.complete).toBe(false);
      expect(sortChecks(result.unchecked.map((entry) => entry.check)).map((check) => check.at)).toEqual(
        [...PARTICIPANT_SIGNATURES].sort(),
      );
    });
  });

  it('always leaves x509 checks unchecked', async () => {
    const { bytes, record } = findValidVector('with an x509 key binding', (r) =>
      signaturesOf(r).some(({ signature }) => signature.key_binding?.method === 'x509'),
    );
    const result = await verifyRecord(bytes, { keySet, did: didResolver(didKeysOf(record)) });
    expectConsistent(result);
    expect(result.problems, formatProblems(result.problems)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.unchecked.length).toBeGreaterThan(0);
    for (const entry of result.unchecked) expect(entry.check.kind).toBe('x509');
  });

  it('always leaves timestamp_token checks unchecked', async () => {
    const record = readExample();
    record.authority_attestation.timestamp_token = TOKEN;
    const result = await verifyRecord(record, { keySet, did: participantDid });
    expectConsistent(result);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.unchecked.map((entry) => entry.check)).toEqual([
      { kind: 'timestamp_token', at: '/authority_attestation', token: TOKEN },
    ]);
  });

  it('runs no external check on a record with problems', async () => {
    const record = readExample();
    record.authority.name = 'Another Consent Authority (fictional)';
    const keySetSpy = vi.fn(keySet);
    const didSpy = vi.fn(participantDid);
    const result = await verifyRecord(record, { keySet: keySetSpy, did: didSpy });
    expectConsistent(result);
    expect(rules(result)).toContain('R20');
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unchecked).toEqual([]);
    expect(keySetSpy).not.toHaveBeenCalled();
    expect(didSpy).not.toHaveBeenCalled();
  });
});
