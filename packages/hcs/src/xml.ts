/**
 * Safe, namespace-aware XML reading for HCS documents.
 *
 * - Any DOCTYPE is rejected and entities are never resolved (HCS 1.0 Draft §8.1).
 * - Input must be UTF-8 (§2.2): byte input is decoded strictly, and an XML declaration that
 *   names another encoding is rejected.
 * - Input size is limited before parsing.
 * - Every element records where it starts and ends in the decoded source, so callers can take
 *   the exact text of an element (for hashing, or for certification checks under §3.3.1).
 */

import { SaxesParser, type SaxesTagNS } from 'saxes';

export const DEFAULT_MAX_BYTES = 1_048_576;

const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const BYTE_ORDER_MARK = '﻿';

export interface XmlAttribute {
  /** Qualified name as written, e.g. `subject` or `ext:note`. */
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  /** Namespace URI; empty for unprefixed attributes, which are in no namespace. */
  readonly uri: string;
  readonly value: string;
}

export interface XmlElement {
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  /** Namespace URI; empty when the element is in no namespace. */
  readonly uri: string;
  /** Attributes in document order, without namespace declarations. */
  readonly attributes: readonly XmlAttribute[];
  /** Namespace declarations made on this element: prefix (empty for default) to URI. */
  readonly namespaces: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Character data directly inside this element (text and CDATA, in document order). */
  readonly text: string;
  /** Index of the element's `<` in the decoded source. */
  readonly start: number;
  /** Index just past the element's final `>` in the decoded source. */
  readonly end: number;
}

export type XmlErrorCode = 'too_large' | 'encoding' | 'doctype' | 'malformed';

export interface XmlError {
  readonly code: XmlErrorCode;
  readonly message: string;
  /** One-based line of the problem, when the parser can tell. */
  readonly line?: number;
  /** One-based column of the problem, when the parser can tell. */
  readonly column?: number;
}

export interface ReadXmlOptions {
  /** Maximum input size in UTF-8 bytes. */
  readonly maxBytes?: number;
}

export type ReadXmlResult =
  | { readonly ok: true; readonly source: string; readonly root: XmlElement }
  | { readonly ok: false; readonly error: XmlError };

interface MutableElement extends XmlElement {
  attributes: XmlAttribute[];
  namespaces: Record<string, string>;
  children: MutableElement[];
  text: string;
  end: number;
}

class Rejected extends Error {
  constructor(readonly code: 'encoding' | 'doctype', message: string) {
    super(message);
  }
}

const fail = (code: XmlErrorCode, message: string): ReadXmlResult => ({
  ok: false,
  error: { code, message },
});

function decode(input: string | Uint8Array, maxBytes: number): string | ReadXmlResult {
  if (typeof input === 'string') {
    const size = new TextEncoder().encode(input).length;
    if (size > maxBytes) return fail('too_large', `input is ${size} bytes; the limit is ${maxBytes}`);
    return input.startsWith(BYTE_ORDER_MARK) ? input.slice(1) : input;
  }
  if (input.length > maxBytes) {
    return fail('too_large', `input is ${input.length} bytes; the limit is ${maxBytes}`);
  }
  try {
    // The decoder drops a leading UTF-8 byte order mark.
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return fail('encoding', 'input is not valid UTF-8');
  }
}

function toElement(tag: SaxesTagNS, start: number): MutableElement {
  const attributes: XmlAttribute[] = [];
  const namespaces: Record<string, string> = {};
  for (const { name, prefix, local, uri, value } of Object.values(tag.attributes)) {
    if (uri === XMLNS_NAMESPACE) {
      namespaces[prefix === '' ? '' : local] = value;
    } else {
      attributes.push({ name, prefix, local, uri, value });
    }
  }
  return {
    name: tag.name,
    prefix: tag.prefix,
    local: tag.local,
    uri: tag.uri,
    attributes,
    namespaces,
    children: [],
    text: '',
    start,
    end: -1,
  };
}

export function readXml(input: string | Uint8Array, options: ReadXmlOptions = {}): ReadXmlResult {
  const decoded = decode(input, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (typeof decoded !== 'string') return decoded;
  const source = decoded;

  const parser = new SaxesParser({ xmlns: true, position: true });
  const open: MutableElement[] = [];
  let root: MutableElement | undefined;
  let tagStart = -1;

  parser.on('doctype', () => {
    throw new Rejected('doctype', 'DOCTYPE declarations are not allowed');
  });
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') {
      throw new Rejected('encoding', `declared encoding ${encoding} is not UTF-8`);
    }
  });
  parser.on('opentagstart', () => {
    // The parser has read `<`, the name and one more character; the name cannot contain `<`.
    tagStart = source.lastIndexOf('<', parser.position - 1);
  });
  parser.on('opentag', (tag) => {
    const element = toElement(tag, tagStart);
    open.at(-1)?.children.push(element);
    open.push(element);
  });
  parser.on('closetag', () => {
    const element = open.pop();
    if (element === undefined) return;
    element.end = parser.position;
    if (open.length === 0) root = element;
  });
  const addText = (text: string) => {
    const current = open.at(-1);
    if (current !== undefined) current.text += text;
  };
  parser.on('text', addText);
  parser.on('cdata', addText);

  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof Rejected) return fail(error.code, error.message);
    const message = error instanceof Error ? error.message.replace(/^\d+:\d+: /, '') : String(error);
    return {
      ok: false,
      error: { code: 'malformed', message, line: parser.line, column: parser.column + 1 },
    };
  }

  if (root === undefined) return fail('malformed', 'document has no root element');
  return { ok: true, source, root };
}
