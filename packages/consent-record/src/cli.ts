/**
 * Verifies a consent authority record file.
 *
 * usage: npm run verify-record -- <record.json> [--public] [--key-sets <file.json>]
 *   --public    also verify the public view (the record without `disclosures`)
 *   --key-sets  a JSON file mapping each `keys_uri` to its JWK Set, for the authority key set check
 *
 * Exit status: 0 when every view verifies, 1 when a problem is found, 2 on a usage or read error.
 */
import { readFileSync } from 'node:fs';
import { parseText } from './ijson';
import { toPublicView } from './check';
import type { JwkSet, Resolvers, VerifyResult } from './types';
import { verifyRecord } from './verify';

const USAGE = 'usage: verify-record <record.json> [--public] [--key-sets <file.json>]';

async function main(args: string[]): Promise<number> {
  let file: string | undefined;
  let keySetsFile: string | undefined;
  let publicView = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--public') publicView = true;
    else if (arg === '--key-sets') keySetsFile = args[++i];
    else if (arg !== undefined && !arg.startsWith('--') && file === undefined) file = arg;
    else return usage(`unexpected argument: ${arg}`);
  }
  if (file === undefined) return usage('no record file given');

  let bytes: Uint8Array;
  let resolvers: Resolvers = {};
  try {
    bytes = readFileSync(file);
    if (keySetsFile !== undefined) {
      const sets = JSON.parse(readFileSync(keySetsFile, 'utf8')) as Record<string, JwkSet>;
      resolvers = { keySet: async (uri) => (Object.hasOwn(sets, uri) ? sets[uri] : undefined) };
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const results: [string, VerifyResult][] = [['full view', await verifyRecord(bytes, resolvers)]];
  if (publicView) {
    const parsed = parseText(bytes);
    if (parsed.ok) results.push(['public view', await verifyRecord(toPublicView(parsed.value), resolvers)]);
  }
  let ok = true;
  const notChecked = new Set<string>();
  for (const [name, result] of results) {
    ok &&= result.valid;
    console.log(`${name}: ${result.valid ? 'OK' : `${result.problems.length} problem(s)`}`);
    for (const p of result.problems) console.log(`  ${p.rule} ${p.at || '/'}: ${p.message}`);
    for (const u of result.unchecked) notChecked.add(`${u.check.kind} at ${u.check.at}: ${u.reason}`);
  }
  for (const line of notChecked) console.log(`not checked: ${line}`);
  if (results[0]?.[1].example) console.log('note: example record; it conveys no consent');
  return ok ? 0 : 1;
}

function usage(message: string): number {
  process.stderr.write(`${message}\n${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
