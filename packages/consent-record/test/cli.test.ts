import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, exampleKey, findCase, isUtf8, readKeySets } from './helpers';

// The CLI: `<record.json>` checks the full view; `--public` also checks the public view;
// `--key-sets <file>` runs the authority key set checks with key sets keyed by keys_uri.
// Exit codes: 0 no problem, 1 problems, 2 usage or file error. Only `full view: OK`,
// `public view: OK` and rule ids are asserted word for word.

const CLI = join(REPO_ROOT, 'packages', 'consent-record', 'src', 'cli.ts');
const EXAMPLE = 'spec/examples/digital-double.example.json';
const KEY_SETS = 'spec/test-vectors/key-sets.json';
const AUTHORITY_KEYS = 'https://authority.example/.well-known/jwks.json';
const TIMEOUT = 60_000;

interface Run {
  readonly status: number | null;
  readonly output: string;
}

function cli(...args: string[]): Run {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Lines that say an authority key set check was not run. */
const keySetNotChecked = (output: string) =>
  output.split(/\r?\n/).filter((line) => /not checked/i.test(line) && /key[ _-]?set|jwks/i.test(line));

const vectorPath = (file: string) => `spec/test-vectors/${file}`;

const scratch = mkdtempSync(join(tmpdir(), 'consent-record-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('verify-record CLI', () => {
  it(
    'checks the full view of the example',
    () => {
      const run = cli(EXAMPLE);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('full view: OK');
    },
    TIMEOUT,
  );

  it(
    'checks the public view too with --public',
    () => {
      const run = cli('--public', EXAMPLE);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('full view: OK');
      expect(run.output).toContain('public view: OK');
    },
    TIMEOUT,
  );

  it(
    'exits 1 and names the rule for a record with a problem',
    () => {
      const vector = findCase('R6');
      const run = cli(vectorPath(vector.file));
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('R6');
      expect(run.output).not.toContain('full view: OK');
    },
    TIMEOUT,
  );

  it(
    'reads the file as bytes: text that is not UTF-8 is R0',
    () => {
      const vector = findCase('R0', (bytes) => !isUtf8(bytes));
      const run = cli(vectorPath(vector.file));
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('R0');
    },
    TIMEOUT,
  );

  it(
    'exits 2 for a file that does not exist',
    () => {
      const run = cli('spec/examples/no-such-record.json');
      expect(run.status, run.output).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'exits 2 without arguments',
    () => {
      const run = cli();
      expect(run.status, run.output).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'runs the authority key set checks with --key-sets',
    () => {
      const without = cli(EXAMPLE);
      expect(without.status, without.output).toBe(0);
      expect(keySetNotChecked(without.output).length, without.output).toBeGreaterThan(0);

      const run = cli('--key-sets', KEY_SETS, EXAMPLE);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('full view: OK');
      expect(keySetNotChecked(run.output), run.output).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'exits 1 with R20 when the key set lacks the attestation key',
    () => {
      const sets = readKeySets();
      const kid = exampleKey('https://authority.example').kid;
      const set = sets[AUTHORITY_KEYS];
      expect(set).toBeDefined();
      const path = join(scratch, 'key-sets-without-attestation-key.json');
      writeFileSync(
        path,
        JSON.stringify({ ...sets, [AUTHORITY_KEYS]: { keys: set!.keys.filter((key) => key['kid'] !== kid) } }),
      );
      const run = cli('--key-sets', path, EXAMPLE);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('R20');
    },
    TIMEOUT,
  );
});
