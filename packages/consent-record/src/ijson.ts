/**
 * R0: the record is I-JSON (RFC 7493 §2). On the text: UTF-8, no duplicate member names
 * (compared after resolving escapes). On every string and member name: no surrogate code
 * point that is not half of a pair, and no noncharacter. Every number is finite.
 */
import { clip, LIMITS } from './limits';
import type { Problem, RuleId } from './types';

// With the `u` flag a well-formed pair matches as one supplementary code point, so `\p{Cs}`
// finds only a lone half. `\p{NChar}` is the 66 noncharacters: U+FDD0 to U+FDEF and the last
// two code points of each plane.
const BAD_CODE_POINT = /[\p{Cs}\p{NChar}]/u;

/** The first surrogate or noncharacter code point in `text` as `U+XXXX`, or undefined. */
export function badCodePoint(text: string): string | undefined {
  const cp = BAD_CODE_POINT.exec(text)?.[0].codePointAt(0);
  return cp === undefined ? undefined : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * R0 on a parsed value: every string, member name and number. A value nested deeper than
 * `LIMITS.depth`, or whose JSON text would be longer than `LIMITS.textBytes`, ends the walk
 * with a `limit` problem. At most `LIMITS.problems` problems.
 */
export function valueProblems(value: unknown): Problem[] {
  const out: Problem[] = [];
  // Document order without recursion, so that deep nesting cannot exhaust the stack: a frame
  // per open array or object, and the path to the value being looked at, which becomes a
  // pointer only for a problem. A member name is checked just before its value.
  type Frame = { readonly node: object; readonly names: readonly string[] | undefined; next: number };
  const frames: Frame[] = [];
  const path: string[] = [];
  // The least text the value takes as JSON: a record given as a value meets the same limit.
  let bytes = 0;
  /** Adds a problem at the path; true when the walk must stop. */
  const report = (rule: RuleId, message: string): boolean => {
    out.push({ rule, at: pointerOf(path), message });
    return rule === 'limit' || out.length >= LIMITS.problems;
  };
  /** Looks at one value, opening a frame for an array or object; true when the walk must stop. */
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') {
      bytes += jsonStringBytes(node);
      const bad = badCodePoint(node);
      if (bad && report('R0', `string holds ${bad}`)) return true;
    } else if (typeof node === 'number') {
      // JSON.parse reads 1E400 as Infinity.
      if (!Number.isFinite(node)) {
        if (report('R0', 'number is beyond the range of an IEEE 754 double')) return true;
      } else {
        bytes += String(node).length;
      }
    } else if (node !== null && typeof node === 'object') {
      if (frames.length === LIMITS.depth) return report('limit', `arrays and objects nest more than ${LIMITS.depth} deep`);
      bytes += 2;
      frames.push({ node, names: Array.isArray(node) ? undefined : Object.keys(node), next: 0 });
    } else {
      bytes += 4;
    }
    return bytes > LIMITS.textBytes && report('limit', `the value is longer than ${LIMITS.textBytes} bytes as JSON text`);
  };
  if (visit(value)) return out;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const { node, names } = frame;
    const i = frame.next++;
    if (i === (names === undefined ? (node as unknown[]).length : names.length)) {
      frames.pop();
      // The outermost value has no token on the path.
      if (frames.length > 0) path.pop();
      continue;
    }
    bytes += i > 0 ? 1 : 0;
    let child: unknown;
    if (names === undefined) {
      child = (node as unknown[])[i];
      path.push(String(i));
    } else {
      const name = names[i]!;
      bytes += jsonStringBytes(name) + 1;
      const bad = badCodePoint(name);
      if (bad && report('R0', `member name holds ${bad}`)) return out;
      child = (node as Record<string, unknown>)[name];
      path.push(name);
    }
    const depth = frames.length;
    if (visit(child)) return out;
    // A scalar is done; an array or object keeps its token until its frame closes.
    if (frames.length === depth) path.pop();
  }
  return out;
}

/**
 * The bytes of `text` as a JSON string: UTF-8, the quotes, and the escapes JSON.stringify
 * writes.
 */
function jsonStringBytes(text: string): number {
  let bytes = Buffer.byteLength(text, 'utf8') + 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE || c === BACKSLASH) bytes += 1;
    else if (c < 0x20) bytes += SHORT_ESCAPES.has(c) ? 1 : 5;
  }
  return bytes;
}

/**
 * Control characters JSON.stringify writes as two characters (`\b`, `\t`, `\n`, `\f`, `\r`);
 * the others take six.
 */
const SHORT_ESCAPES: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** An RFC 6901 pointer to the path, cut to `LIMITS.problemChars`. */
function pointerOf(path: readonly string[]): string {
  let out = '';
  for (const token of path) {
    out += `/${pointerToken(token.slice(0, LIMITS.problemChars))}`;
    if (out.length > LIMITS.problemChars) break;
  }
  return clip(out);
}

export type TextResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problems: Problem[] };

/**
 * R0 on the text, then the parsed value. A byte order mark is not accepted (RFC 8259 §8.1).
 * The nesting is measured before the text is parsed: JSON.parse would build the whole value
 * first, and deep nesting takes far more memory than its text.
 */
export function parseText(input: string | Uint8Array): TextResult {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length;
  if (bytes > LIMITS.textBytes) {
    return { ok: false, problems: [{ rule: 'limit', at: '', message: `the text is longer than ${LIMITS.textBytes} bytes` }] };
  }
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return fail('the text is not UTF-8');
    }
  }
  const structure = structureOf(text);
  if (structure.deep) {
    return { ok: false, problems: [{ rule: 'limit', at: '', message: `arrays and objects nest more than ${LIMITS.depth} deep` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(`the text is not JSON: ${(error as Error).message}`);
  }
  if (structure.duplicates.length > 0) return { ok: false, problems: structure.duplicates };
  return { ok: true, value };
}

function fail(message: string): TextResult {
  return { ok: false, problems: [{ rule: 'R0', at: '', message }] };
}

/** What `structureOf` finds in JSON text. */
export interface Structure {
  /** Arrays and objects nest more than `LIMITS.depth` deep. */
  readonly deep: boolean;
  /** Duplicate member names, at most `LIMITS.problems`. */
  readonly duplicates: Problem[];
}

/**
 * The nesting and the duplicate member names of JSON text, without parsing it. Member names
 * are compared after resolving escapes, so `"\u0061"` and `"a"` are the same name. Linear in
 * the text, and only member names are decoded. On text that is not JSON the answer may be
 * wrong, but it is found as quickly.
 */
export function structureOf(text: string): Structure {
  const duplicates: Problem[] = [];
  // One entry per open container: the member names seen so far, or null for an array.
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      const end = stringEnd(text, i);
      const names = stack[stack.length - 1];
      if (names && duplicates.length < LIMITS.problems) {
        let j = end;
        while (j < text.length && isWhitespace(text.charCodeAt(j))) j++;
        if (text.charCodeAt(j) === COLON) {
          const name = decodeString(text.slice(i, end));
          if (names.has(name)) duplicates.push({ rule: 'R0', at: '', message: clip(`duplicate member name ${JSON.stringify(name)}`) });
          else names.add(name);
        }
      }
      i = end;
      continue;
    }
    if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
      if (stack.length === LIMITS.depth) return { deep: true, duplicates };
      stack.push(c === OPEN_OBJECT ? new Set() : null);
    } else if (c === CLOSE_OBJECT || c === CLOSE_ARRAY) {
      stack.pop();
    }
    i++;
  }
  return { deep: false, duplicates };
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

/** JSON insignificant whitespace (RFC 8259 §2). */
function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * The index after the string literal that starts at `start` (a quote): after the first quote
 * that an even number of backslashes precede. Each backslash is counted once, since a run of
 * them ends at the quote it precedes.
 */
function stringEnd(text: string, start: number): number {
  let from = start + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote < 0) return text.length;
    let k = quote - 1;
    while (k > start && text.charCodeAt(k) === BACKSLASH) k--;
    if ((quote - 1 - k) % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

/**
 * A string literal's value; the literal itself when it is not valid, as in text that is not
 * JSON.
 */
function decodeString(literal: string): string {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return literal;
  }
}

/** RFC 6901 reference token. */
export function pointerToken(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}
