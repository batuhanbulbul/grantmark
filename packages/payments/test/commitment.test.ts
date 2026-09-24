import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, commitmentMemo } from '../src/commitment';

describe('canonicalJson (RFC 8785 subset)', () => {
  it('sorts object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x', { d: 2, c: 3 }] })).toBe('{"a":[true,null,"x",{"c":3,"d":2}],"b":1}');
  });

  it('escapes strings like JSON and sorts keys by UTF-16 code units', () => {
    expect(canonicalJson({ 'é': 'a"b\n', z: '€' })).toBe('{"z":"€","é":"a\\"b\\n"}');
  });

  it.each([
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a non-finite number', { a: Number.POSITIVE_INFINITY }],
    ['a bigint', { a: 1n }],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe('commitmentMemo', () => {
  it('is gm1: plus the base64url SHA-256 of the canonical JSON', () => {
    const commitment = { license_request: 'lrq_1', amount: { value: '5.00', currency: 'USD' } };
    const digest = createHash('sha256').update(canonicalJson(commitment)).digest('base64url');
    expect(commitmentMemo(commitment)).toBe(`gm1:${digest}`);
    expect(commitmentMemo(commitment)).toHaveLength(47);
  });

  it('does not depend on key order', () => {
    expect(commitmentMemo({ a: 1, b: 2 })).toBe(commitmentMemo({ b: 2, a: 1 }));
    expect(commitmentMemo({ a: 1, b: 2 })).not.toBe(commitmentMemo({ a: 1, b: 3 }));
  });
});
