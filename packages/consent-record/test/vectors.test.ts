import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRecord, checkRecordText, toPublicView, verifyRecord } from '../src/index';
import type { CheckResult, Problem } from '../src/index';
import {
  CASES_URL,
  RULES_AFTER_SCHEMA,
  RULE_IDS,
  decodeUtf8,
  didKeysOf,
  didResolver,
  expectedExternalChecks,
  formatProblems,
  isJsonPointer,
  keySetResolver,
  readExample,
  readIndex,
  readKeySets,
  sortChecks,
  vectorBytes,
  type ConsentRecord,
  type VectorCase,
} from './helpers';

// spec/test-vectors/README.md: "valid" means no problem in the record as given (the full
// view) and in its public view; a rule id means at least one problem under that rule.

const index = readIndex();
const keySet = keySetResolver(readKeySets());
const EXPECTATIONS = new Set<string>(['valid', ...RULE_IDS.filter((rule) => rule !== 'limit' && rule !== 'internal')]);

const ruleAndPlace = (problems: readonly Problem[]) => problems.map((p) => `${p.rule} ${p.at}`).sort();

function expectWellFormedProblems(result: CheckResult): void {
  for (const problem of result.problems) {
    expect(RULE_IDS).toContain(problem.rule);
    expect(isJsonPointer(problem.at), `not a JSON Pointer: ${JSON.stringify(problem.at)}`).toBe(true);
    expect(typeof problem.message).toBe('string');
    expect(problem.message.length).toBeGreaterThan(0);
  }
}

describe('test vector index', () => {
  it('counts every case file, and lists each one once', () => {
    const files = readdirSync(CASES_URL)
      .filter((name) => name.endsWith('.json'))
      .map((name) => `cases/${name}`)
      .sort();
    expect(index.count).toBe(index.cases.length);
    expect(index.cases.length).toBe(files.length);
    expect(index.cases.map((vector) => vector.file).sort()).toEqual(files);
    expect(new Set(index.cases.map((vector) => vector.id)).size).toBe(index.cases.length);
  });

  it('names the profile of the example and expects only "valid" or a rule id', () => {
    expect(index.profile).toBe(readExample().profile);
    for (const vector of index.cases) {
      expect(EXPECTATIONS.has(vector.expect), `${vector.id}: ${vector.expect}`).toBe(true);
    }
  });

  it('has valid cases and cases for every rule', () => {
    const expected = new Set(index.cases.map((vector) => vector.expect));
    for (const expectation of EXPECTATIONS) expect(expected.has(expectation), expectation).toBe(true);
  });
});

describe('checkRecordText and verifyRecord on every test vector', () => {
  it.each([...index.cases])('$id ($expect): $description', async (vector: VectorCase) => {
    const bytes = vectorBytes(vector);
    const result = checkRecordText(bytes);
    expectWellFormedProblems(result);
    const verified = await verifyRecord(bytes, { keySet });
    expect(verified.valid).toBe(verified.problems.length === 0);
    expect(verified.complete).toBe(verified.valid && verified.unchecked.length === 0);

    if (vector.expect === 'valid') {
      expect(result.problems, formatProblems(result.problems)).toEqual([]);
      const record = JSON.parse(decodeUtf8(bytes)) as ConsentRecord;
      expect(result.view).toBe('disclosures' in record ? 'full' : 'public');
      expect(result.example).toBe(record.example === true);
      expect(sortChecks(result.external)).toEqual(expectedExternalChecks(record));

      const publicView = checkRecord(toPublicView(record));
      expect(publicView.problems, `public view:\n${formatProblems(publicView.problems)}`).toEqual([]);
      expect(publicView.view).toBe('public');
      // Every signature covers the committed form, so both views list the same checks.
      expect(sortChecks(publicView.external)).toEqual(expectedExternalChecks(record));

      // With the example key sets, every authority key set check runs and passes.
      expect(verified.problems, formatProblems(verified.problems)).toEqual([]);
      expect(verified.valid).toBe(true);
      expect(verified.unchecked.filter((entry) => entry.check.kind === 'authority_key_set')).toEqual([]);
      expect(verified.view).toBe(result.view);
      expect(verified.example).toBe(result.example);

      // With a DID resolver too, only X.509 and time-stamp checks stay unchecked.
      const all = await verifyRecord(bytes, { keySet, did: didResolver(didKeysOf(record)) });
      expect(all.problems, formatProblems(all.problems)).toEqual([]);
      expect(all.valid).toBe(true);
      for (const entry of all.unchecked) expect(['x509', 'timestamp_token']).toContain(entry.check.kind);
      expect(all.complete).toBe(all.unchecked.length === 0);
    } else {
      expect(
        result.problems.some((problem) => problem.rule === vector.expect),
        `expected a ${vector.expect} problem, got:\n${formatProblems(result.problems)}`,
      ).toBe(true);
      // Checks that need outside data are listed only for a record without problems.
      expect(result.external).toEqual([]);
      expect(
        verified.problems.some((problem) => problem.rule === vector.expect),
        `verifyRecord: expected a ${vector.expect} problem, got:\n${formatProblems(verified.problems)}`,
      ).toBe(true);
      expect(verified.valid).toBe(false);
      expect(verified.complete).toBe(false);
      expect(verified.unchecked).toEqual([]);
    }

    if (vector.expect === 'schema' || vector.expect === 'R0') {
      // R1 to R20 run only on a record that passes R0 and the schema (src/index.ts).
      const later = result.problems.filter((problem) => RULES_AFTER_SCHEMA.test(problem.rule));
      expect(later, formatProblems(later)).toEqual([]);
    } else {
      // Valid UTF-8 without duplicate names or bad code points: the text adds nothing to
      // what checkRecord finds on the parsed value.
      const parsed = checkRecord(JSON.parse(decodeUtf8(bytes)));
      expect(ruleAndPlace(parsed.problems)).toEqual(ruleAndPlace(result.problems));
      expect(sortChecks(parsed.external)).toEqual(sortChecks(result.external));
      expect(parsed.view).toBe(result.view);
      expect(parsed.example).toBe(result.example);
    }
  });
});
