/**
 * JSON Schema 2020-12 validation against spec/consent-authority-record.schema.json, with the
 * `format` keywords asserted (spec/README.md, "Validation rules beyond JSON Schema").
 */
import { readFileSync } from 'node:fs';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { isInstant } from './encoding';
import { LIMITS } from './limits';
import type { Problem } from './types';

const SCHEMA_URL = new URL('../../../spec/consent-authority-record.schema.json', import.meta.url);

/** RFC 3986 §3: scheme ":" then unreserved, reserved and percent-encoded characters. */
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*$/;

let validator: ValidateFunction | undefined;

function compile(): ValidateFunction {
  // Strict about unknown keywords and formats. The style checks are off: the schema uses open
  // tuples and type-less `if`/`then` subschemas, which are valid 2020-12 and intended.
  // Stops at the first error: the record is untrusted, and collecting every error lets a
  // large record cost far more than it takes to reject it.
  const ajv = new Ajv2020({
    allErrors: false,
    strict: true,
    strictTuples: false,
    strictTypes: false,
    strictRequired: false,
    validateFormats: true,
  });
  // `dateTime` also has a pattern; the format adds the calendar (no 30 February).
  ajv.addFormat('date-time', { type: 'string', validate: isInstant });
  // An absolute URI: a scheme, then only the characters RFC 3986 §2 allows, each `%` starting
  // a percent-encoded octet. No IRIs: a URI parser and a URL parser then read it alike.
  ajv.addFormat('uri', { type: 'string', validate: (v) => URI.test(v) });
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as object);
}

export function schemaProblems(record: unknown): Problem[] {
  validator ??= compile();
  if (validator(record)) return [];
  return (validator.errors ?? []).slice(0, LIMITS.problems).map((e) => ({
    rule: 'schema' as const,
    at: e.instancePath,
    message: `${e.keyword}: ${e.message ?? 'invalid'}`,
  }));
}
