import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BYTES, readXml, type XmlElement } from '../src/xml';

function read(input: string | Uint8Array, maxBytes?: number) {
  const result = readXml(input, maxBytes === undefined ? {} : { maxBytes });
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function errorCode(input: string | Uint8Array, maxBytes?: number) {
  const result = readXml(input, maxBytes === undefined ? {} : { maxBytes });
  return result.ok ? 'ok' : result.error.code;
}

const slice = (source: string, element: XmlElement) => source.slice(element.start, element.end);

describe('readXml: element tree', () => {
  it('resolves namespaces for elements and attributes', () => {
    const { root } = read(
      '<r xmlns="urn:a" xmlns:b="urn:b" x="1" b:y="2"><b:c/><d xmlns=""/></r>',
    );
    expect(root).toMatchObject({ name: 'r', prefix: '', local: 'r', uri: 'urn:a' });
    expect(root.namespaces).toEqual({ '': 'urn:a', b: 'urn:b' });
    expect(root.attributes).toEqual([
      { name: 'x', prefix: '', local: 'x', uri: '', value: '1' },
      { name: 'b:y', prefix: 'b', local: 'y', uri: 'urn:b', value: '2' },
    ]);
    expect(root.children.map((c) => [c.name, c.uri])).toEqual([
      ['b:c', 'urn:b'],
      ['d', ''],
    ]);
    expect(root.children[0]?.namespaces).toEqual({});
  });

  it('collects direct text and CDATA in document order, decoding references', () => {
    const { root } = read('<r>a &amp; b<![CDATA[ <c> & ]]><x>inner</x>&#x41;</r>');
    expect(root.text).toBe('a & b <c> & A');
    expect(root.children[0]?.text).toBe('inner');
  });

  it('normalizes line endings in text as XML requires', () => {
    const { root } = read('<r>a\r\nb\rc</r>');
    expect(root.text).toBe('a\nb\nc');
  });

  it('ignores comments and processing instructions', () => {
    const { root } = read('<?xml version="1.0"?><!-- c --><?pi data?><r><!-- x -->t<?pi?></r>');
    expect(root.text).toBe('t');
    expect(root.children).toEqual([]);
  });
});

describe('readXml: exact source offsets', () => {
  it('covers the whole element for normal, self-closing and nested elements', () => {
    const source = '<r>\n  <a k="v">x<a/></a >\n  <b/><c\r\n   k="v"\t/></r>';
    const { root } = read(source);
    const [a, b, c] = root.children;
    expect(slice(source, root)).toBe(source);
    expect(slice(source, a!)).toBe('<a k="v">x<a/></a >');
    expect(slice(source, a!.children[0]!)).toBe('<a/>');
    expect(slice(source, b!)).toBe('<b/>');
    expect(slice(source, c!)).toBe('<c\r\n   k="v"\t/>');
  });

  it('counts astral characters as JavaScript string indices', () => {
    const source = '<r>😀🎉<a>é</a><b>𝄞</b></r>';
    const { root } = read(source);
    expect(root.children.map((e) => slice(source, e))).toEqual(['<a>é</a>', '<b>𝄞</b>']);
  });
});

describe('readXml: byte input', () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  it('decodes UTF-8 bytes and reports offsets into the decoded source', () => {
    const result = read(encode('<r><a>ü</a></r>'));
    expect(result.source).toBe('<r><a>ü</a></r>');
    expect(slice(result.source, result.root.children[0]!)).toBe('<a>ü</a>');
  });

  it('drops a UTF-8 byte order mark before offsets are counted', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<r><a/></r>')]);
    const result = read(bytes);
    expect(result.source).toBe('<r><a/></r>');
    expect(slice(result.source, result.root.children[0]!)).toBe('<a/>');
  });

  it('drops a byte order mark at the start of string input', () => {
    const result = read('﻿<r/>');
    expect(result.source).toBe('<r/>');
    expect(slice(result.source, result.root)).toBe('<r/>');
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(errorCode(new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e]))).toBe(
      'encoding',
    );
  });

  it('rejects UTF-16 input', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e, 0x00]);
    expect(errorCode(utf16)).toBe('encoding');
  });
});

describe('readXml: encoding declaration', () => {
  it('accepts UTF-8 in any letter case', () => {
    expect(errorCode('<?xml version="1.0" encoding="UTF-8"?><r/>')).toBe('ok');
    expect(errorCode('<?xml version="1.0" encoding="utf-8"?><r/>')).toBe('ok');
    expect(errorCode('<?xml version="1.0"?><r/>')).toBe('ok');
  });

  it('rejects any other declared encoding (HCS 1.0 Draft §2.2)', () => {
    expect(errorCode('<?xml version="1.0" encoding="ISO-8859-1"?><r/>')).toBe('encoding');
    expect(errorCode('<?xml version="1.0" encoding="UTF-16"?><r/>')).toBe('encoding');
  });
});

describe('readXml: DOCTYPE is always rejected (HCS 1.0 Draft §8.1)', () => {
  it.each([
    ['a bare DOCTYPE', '<!DOCTYPE r><r/>'],
    ['an external DTD', '<!DOCTYPE r SYSTEM "https://evil.example/r.dtd"><r/>'],
    [
      'an external entity (XXE)',
      '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><r>&xxe;</r>',
    ],
    [
      'nested entity expansion',
      '<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><r>&b;</r>',
    ],
  ])('%s', (_label, input) => {
    expect(errorCode(input)).toBe('doctype');
  });
});

describe('readXml: malformed input', () => {
  it.each([
    ['an unclosed element', '<r><a></r>'],
    ['mismatched tags', '<r></x>'],
    ['an unbound prefix', '<r><p:a/></r>'],
    ['text after the root', '<r/>text'],
    ['a second root', '<r/><r/>'],
    ['an undefined entity', '<r>&nope;</r>'],
    ['a duplicate attribute', '<r a="1" a="2"/>'],
    ['empty input', ''],
  ])('%s', (_label, input) => {
    expect(errorCode(input)).toBe('malformed');
  });

  it('reports the line and column of the problem', () => {
    const result = readXml('<r>\n  <a>\n</r>');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.line).toBe(3);
      expect(result.error.column).toBeGreaterThan(0);
    }
  });
});

describe('readXml: size limit', () => {
  it('defaults to 1 MiB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(1_048_576);
    const big = `<r>${'x'.repeat(DEFAULT_MAX_BYTES)}</r>`;
    expect(errorCode(big)).toBe('too_large');
  });

  it('measures string input in UTF-8 bytes', () => {
    const input = '<r>éé</r>'; // 11 bytes in UTF-8, 9 UTF-16 code units
    expect(errorCode(input, 11)).toBe('ok');
    expect(errorCode(input, 10)).toBe('too_large');
  });

  it('measures byte input by length', () => {
    const bytes = new TextEncoder().encode('<r/>');
    expect(errorCode(bytes, 4)).toBe('ok');
    expect(errorCode(bytes, 3)).toBe('too_large');
  });
});
