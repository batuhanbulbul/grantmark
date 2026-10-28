/**
 * RFC 8785 JSON Canonicalization Scheme. RFC 8785 defines its serialization with the
 * ECMAScript JSON.stringify rules for strings and numbers (§3.2.2), so JSON.stringify is
 * the serializer here; member names are sorted by UTF-16 code units (§3.2.3), which is the
 * default string order of Array.prototype.sort. Input must be I-JSON (RFC 7493).
 */
import { badCodePoint, pointerToken } from './ijson';

export function canonicalize(value: unknown): string {
  return serialize(value, []);
}

/** `path` leads to `value`; it is only read to name the place of an error. */
function serialize(value: unknown, path: (string | number)[]): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${where(path)}: ${value} is not an I-JSON number`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    checkString(value, path);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Every index, holes too: a hole reads as undefined, which is not a JSON value.
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      path.push(i);
      items.push(serialize(value[i], path));
      path.pop();
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const members: string[] = [];
    for (const name of Object.keys(value).sort()) {
      checkString(name, path);
      path.push(name);
      members.push(`${JSON.stringify(name)}:${serialize((value as Record<string, unknown>)[name], path)}`);
      path.pop();
    }
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`${where(path)}: ${describe(value)} is not a JSON value`);
}

function where(path: readonly (string | number)[]): string {
  return path.length === 0 ? '/' : path.map((p) => `/${pointerToken(String(p))}`).join('');
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkString(text: string, path: readonly (string | number)[]): void {
  const bad = badCodePoint(text);
  if (bad !== undefined) throw new TypeError(`${where(path)}: holds ${bad}, which I-JSON forbids`);
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return typeof value;
}
