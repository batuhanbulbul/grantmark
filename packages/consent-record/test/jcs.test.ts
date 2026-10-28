import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/index';
import {
  decodeUtf8,
  instructionMembers,
  readExample,
  readIndex,
  signaturesOf,
  vectorBytes,
  type ConsentRecord,
} from './helpers';

// RFC 8785 (JCS). Expected outputs are those the RFC states; JSON texts are written with
// `\\u` so that the parser, not the TypeScript source, resolves their escapes.

/** The digest rule of spec/README.md: base64url(SHA-256(UTF-8(JCS(value)))), without padding. */
const digestOf = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value), 'utf8').digest('base64url');

function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

const char = (codePoint: number) => String.fromCodePoint(codePoint);
const unit = (codeUnit: number) => String.fromCharCode(codeUnit);

describe('RFC 8785 examples', () => {
  it('canonicalizes the sample of sections 3.2.2 and 3.2.3', () => {
    const parsed: unknown = JSON.parse(`{
      "numbers": [333333333.33333329, 1E30, 4.50,
                  2e-3, 0.000000000000000000000000001],
      "string": "\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\"\\/",
      "literals": [null, true, false]
    }`);
    expect(canonicalize(parsed)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u{20AC}$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('yields the UTF-8 bytes of section 3.2.4', () => {
    const parsed: unknown = JSON.parse(`{
      "numbers": [333333333.33333329, 1E30, 4.50,
                  2e-3, 0.000000000000000000000000001],
      "string": "\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\"\\/",
      "literals": [null, true, false]
    }`);
    const hex = `
      7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
      75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
      5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
      65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
      5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
      30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.replace(/\s+/g, '');
    expect(Buffer.from(canonicalize(parsed), 'utf8').toString('hex')).toBe(hex);
  });

  it('sorts member names by UTF-16 code units (section 3.2.3 test data)', () => {
    const parsed: unknown = JSON.parse(`{
      "\\u20ac": "Euro Sign",
      "\\r": "Carriage Return",
      "\\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\\ud83d\\ude00": "Emoji: Grinning Face",
      "\\u0080": "Control",
      "\\u00f6": "Latin Small Letter O With Diaeresis"
    }`);
    const values = [...canonicalize(parsed).matchAll(/:"([^"]*)"/g)].map((match) => match[1]);
    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  it('sorts "", "a", "aa", "ab" in that order (section 3.2.3)', () => {
    expect(canonicalize({ ab: 4, aa: 3, a: 2, '': 1 })).toBe('{"":1,"a":2,"aa":3,"ab":4}');
  });

  // Appendix B, every row with a stated JSON representation.
  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('serializes the IEEE 754 value %s as %s (Appendix B)', (bits, json) => {
    expect(canonicalize(fromBits(bits))).toBe(json);
    expect(canonicalize([fromBits(bits)])).toBe(`[${json}]`);
  });

  it.each([
    ['7fffffffffffffff', 'NaN'],
    ['7ff0000000000000', 'Infinity'],
  ])('rejects the IEEE 754 value %s (%s, Appendix B)', (bits) => {
    expect(() => canonicalize(fromBits(bits))).toThrow(TypeError);
  });
});

describe('serialization (RFC 8785 section 3.2)', () => {
  it('writes the literals as null, true and false', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize([null, true, false])).toBe('[null,true,false]');
  });

  it.each([
    [0x00, '\\u0000'],
    [0x01, '\\u0001'],
    [0x08, '\\b'],
    [0x09, '\\t'],
    [0x0a, '\\n'],
    [0x0b, '\\u000b'],
    [0x0c, '\\f'],
    [0x0d, '\\r'],
    [0x0e, '\\u000e'],
    [0x1f, '\\u001f'],
    [0x22, '\\"'],
    [0x5c, '\\\\'],
  ])('escapes the code unit %i as %s (section 3.2.2.2)', (codePoint, escaped) => {
    expect(canonicalize(unit(codePoint))).toBe(`"${escaped}"`);
    expect(canonicalize({ [unit(codePoint)]: 0 })).toBe(`{"${escaped}":0}`);
  });

  it('writes every other character as is', () => {
    for (const codePoint of [0x20, 0x2f, 0x41, 0x7f, 0x80, 0xe9, 0x2028, 0x2029, 0x20ac, 0xfeff, 0x1f600]) {
      const text = `a${char(codePoint)}b`;
      expect(canonicalize(text), codePoint.toString(16)).toBe(`"${text}"`);
    }
  });

  it('sorts members recursively, inside arrays too, and keeps array order', () => {
    expect(canonicalize({ b: [{ d: 1, c: [3, 1, 2] }, 'x'], a: { z: null, y: { k: true, j: false } } })).toBe(
      '{"a":{"y":{"j":false,"k":true},"z":null},"b":[{"c":[3,1,2],"d":1},"x"]}',
    );
  });

  it('writes no whitespace and handles empty containers', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
    expect(canonicalize('')).toBe('""');
  });

  it('serializes integers as ECMAScript does', () => {
    expect(canonicalize([0, -1, 1, 9007199254740991, -9007199254740991, 1e21, 1e20])).toBe(
      '[0,-1,1,9007199254740991,-9007199254740991,1e+21,100000000000000000000]',
    );
  });

  it('keeps a member named __proto__', () => {
    const parsed: unknown = JSON.parse('{"b":1,"__proto__":{"c":2}}');
    expect(canonicalize(parsed)).toBe('{"__proto__":{"c":2},"b":1}');
  });

  it('sorts names that differ only past a shared prefix and by length', () => {
    expect(canonicalize({ ba: 1, b: 2, a: 3, B: 4, aB: 5 })).toBe('{"B":4,"a":3,"aB":5,"b":2,"ba":1}');
  });

  it('does not change its input', () => {
    const value = { b: [2, 1], a: { d: 1, c: 2 } };
    const before = JSON.stringify(value);
    canonicalize(value);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('values that are not I-JSON', () => {
  it('rejects NaN and infinities wherever they appear', () => {
    for (const value of [NaN, Infinity, -Infinity, [1, NaN], { a: Infinity }, { a: [{ b: -Infinity }] }]) {
      expect(() => canonicalize(value)).toThrow(TypeError);
    }
  });

  it('rejects lone surrogates in strings and member names', () => {
    const lone = [
      unit(0xd800),
      unit(0xdbff),
      unit(0xdc00),
      unit(0xdfff),
      `a${unit(0xd83d)}`,
      `${unit(0xde00)}a`,
      unit(0xde00) + unit(0xd83d),
    ];
    for (const text of lone) {
      expect(() => canonicalize(text)).toThrow(TypeError);
      expect(() => canonicalize({ [text]: 1 })).toThrow(TypeError);
      expect(() => canonicalize([{ a: [text] }])).toThrow(TypeError);
    }
  });

  it('accepts a surrogate pair', () => {
    const pair = unit(0xd83d) + unit(0xde00);
    expect(canonicalize(pair)).toBe(`"${pair}"`);
    expect(canonicalize({ [pair]: pair })).toBe(`{"${pair}":"${pair}"}`);
  });

  // U+FDD0 to U+FDEF, and the last two code points of each of the 17 planes: 66 in all.
  const noncharacters: number[] = [];
  for (let codePoint = 0xfdd0; codePoint <= 0xfdef; codePoint++) noncharacters.push(codePoint);
  for (let plane = 0; plane <= 0x10; plane++) noncharacters.push(plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff);

  it('knows 66 noncharacters', () => {
    expect(noncharacters).toHaveLength(66);
  });

  it.each(noncharacters.map((codePoint) => [codePoint.toString(16).toUpperCase(), codePoint]))(
    'rejects the noncharacter U+%s in a string and a member name',
    (_name, codePoint) => {
      const text = `x${char(codePoint)}y`;
      expect(() => canonicalize(text)).toThrow(TypeError);
      expect(() => canonicalize({ [text]: 1 })).toThrow(TypeError);
      expect(() => canonicalize({ a: [text] })).toThrow(TypeError);
    },
  );

  it('accepts the code points next to the noncharacters', () => {
    for (const codePoint of [0xfdcf, 0xfdf0, 0xfffd, 0xe000, 0x1fffd, 0x20000, 0x10fffd, 0x100000]) {
      const text = char(codePoint);
      expect(canonicalize(text), codePoint.toString(16)).toBe(`"${text}"`);
      expect(canonicalize({ [text]: 1 }), codePoint.toString(16)).toBe(`{"${text}":1}`);
    }
  });

  it('rejects undefined, functions, bigints and symbols', () => {
    const values: unknown[] = [
      undefined,
      [undefined],
      { a: undefined },
      () => 1,
      [() => 1],
      { a: () => 1 },
      10n,
      { a: 10n },
      Symbol('s'),
      [Symbol('s')],
    ];
    for (const value of values) {
      expect(() => canonicalize(value), String(Array.isArray(value) ? 'array' : typeof value)).toThrow(TypeError);
    }
  });
});

describe('digests of the example record (spec/README.md, "Signing statements")', () => {
  const record = readExample();

  it('reproduces agreement_digest.value of both versions', () => {
    expect(record.agreements).toHaveLength(2);
    for (const version of record.agreements) {
      expect(digestOf(version.agreement)).toBe(version.agreement_digest.value);
    }
  });

  it('reproduces every commitment from its disclosure', () => {
    const disclosures = Object.entries(record.disclosures ?? {});
    expect(disclosures.length).toBeGreaterThan(0);
    for (const [commitment, { salt, value }] of disclosures) {
      expect(digestOf([salt, value])).toBe(commitment);
    }
  });

  it('reproduces the event chain and its ref_digest values', () => {
    const { events } = record.state;
    expect(events[0]?.prev_digest).toBeNull();
    events.forEach((event, i) => {
      if (i > 0) expect(event.prev_digest, `event ${event.seq}`).toBe(digestOf(events[i - 1]));
      if (event.type === 'issued' || event.type === 'version_added') {
        expect(event.ref_digest).toBe(digestOf(record.agreements[Number(event['version']) - 1]));
      }
      if (event.type === 'payment_recorded') {
        const payment = record.state.payments?.find((p) => p.payment_id === event['ref']);
        expect(payment).toBeDefined();
        expect(event.ref_digest).toBe(digestOf(payment));
      }
      if (event.type === 'asset_bound') {
        const binding = record.state.asset_bindings?.find((b) => b.binding_id === event['ref']);
        expect(binding).toBeDefined();
        expect(event.ref_digest).toBe(digestOf(binding));
      }
    });
  });

  it('verifies every signature of the example over the canonical signing statement', () => {
    const statementDigest = (at: string, source: ConsentRecord): [string, string] => {
      if (at === '/authority_attestation') {
        const rest: Record<string, unknown> = { ...source };
        delete rest['disclosures'];
        delete rest['authority_attestation'];
        return ['record_attestation', digestOf(rest)];
      }
      const event = /^\/state\/events\/(\d+)\//.exec(at);
      if (event) {
        const found = source.state.events[Number(event[1])]!;
        if (found.type === 'authority_transferred') {
          const rest: Record<string, unknown> = { ...found };
          delete rest['actor_signature'];
          return ['authority_transfer', digestOf(rest)];
        }
        return ['event_instruction', digestOf(instructionMembers(found))];
      }
      const version = /^\/agreements\/(\d+)\//.exec(at);
      expect(version, at).not.toBeNull();
      return ['agreement', digestOf(source.agreements[Number(version![1])]!.agreement)];
    };
    const signatures = signaturesOf(record);
    expect(signatures.length).toBeGreaterThan(3);
    for (const { at, signature } of signatures) {
      const [statement, digest] = statementDigest(at, record);
      const payload = canonicalize({
        profile: record.profile,
        record_uri: record.record_uri,
        statement,
        digest,
        signer: signature.signer,
        signed_at: signature.signed_at,
      });
      const [header, , value] = signature.value.split('.');
      const key = createPublicKey({ key: signature.jwk as JsonWebKey, format: 'jwk' });
      const ok = verify(null, Buffer.from(`${header}.${payload}`, 'utf8'), key, Buffer.from(value ?? '', 'base64url'));
      expect(ok, at).toBe(true);
    }
  });
});

describe('digests of the valid test vectors', () => {
  it('reproduces agreement_digest.value of every version in every valid vector', () => {
    const valid = readIndex().cases.filter((vector) => vector.expect === 'valid');
    expect(valid.length).toBeGreaterThan(0);
    for (const vector of valid) {
      const record = JSON.parse(decodeUtf8(vectorBytes(vector))) as ConsentRecord;
      for (const version of record.agreements) {
        expect(digestOf(version.agreement), `${vector.id} version ${version.agreement.version}`).toBe(
          version.agreement_digest.value,
        );
      }
    }
  });
});
