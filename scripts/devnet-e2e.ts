/**
 * End to end on Solana devnet: request a paid license from a running Grantmark server, pay it
 * with a local devnet keypair, and receive the License token.
 *
 *   GRANTMARK_URL=http://localhost:8787 CLIENT_ID=demo-studio CLIENT_SECRET=… \
 *   PAYER_KEYPAIR=~/.config/solana/devnet-payer.json npx tsx scripts/devnet-e2e.ts
 *
 * The keypair file is the Solana CLI format (a JSON array of 64 numbers). Use a devnet-only
 * wallet funded with devnet SOL (faucet.solana.com) and devnet USDC (faucet.circle.com).
 * The server needs DEMO_RIGHTS_HOLDER_WALLET set when it was seeded.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DEVNET_GENESIS_HASH, DEVNET_RPC_URL, associatedTokenAccount } from '@grantmark/payments';
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signTransaction,
  createKeyPairFromBytes,
} from '@solana/kit';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`set ${name}`);
  return value;
};

const base = env('GRANTMARK_URL', 'http://localhost:8787').replace(/\/+$/, '');
const resource = env('RESOURCE', 'HCRN-0000-0068-F');
const scope = env('SCOPE', 'image');
const auth = `Basic ${Buffer.from(`${env('CLIENT_ID', 'demo-studio')}:${env('CLIENT_SECRET')}`).toString('base64')}`;
const keypairPath = env('PAYER_KEYPAIR').replace(/^~/, homedir());
const rpc = createSolanaRpc(env('SOLANA_RPC_URL', DEVNET_RPC_URL));

async function post(path: string, form: Record<string, string>) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS_HASH) throw new Error('the RPC endpoint is not devnet');

  const bytes = new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  const payer = signer.address;
  console.log(`payer ${payer}`);

  const lamports = (await rpc.getBalance(payer).send()).value;
  if (lamports < 10_000_000n) throw new Error(`payer has ${lamports} lamports; get devnet SOL at https://faucet.solana.com`);
  const usdcAccount = address(await associatedTokenAccount(payer));
  const usdc = await rpc
    .getTokenAccountBalance(usdcAccount)
    .send()
    .then((r) => r.value.uiAmountString)
    .catch(() => '0');
  console.log(`payer balance: ${Number(lamports) / 1e9} SOL, ${usdc} USDC`);

  const declaration = await (await fetch(`${base}/registry/declarations/${resource}`)).text();
  const license = declaration.match(/<license>[\s\S]*?<\/license>/)?.[0];
  if (license === undefined) throw new Error(`no <license> in ${resource}`);
  const form = { grant_type: 'client_credentials', license, resource, scope };

  const first = await post('/olp/token', { ...form, payer });
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${JSON.stringify(first.body)}`);
  const payment = first.body.payment;
  const option = payment.accepts[0];
  console.log(`payment ${payment.id}: ${payment.amount.value} ${payment.amount.currency} → ${option.pay_to.map((p: any) => `${p.role} ${p.amount}`).join(', ')}`);

  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(option.transaction));
  const signed = await signTransaction([await createKeyPairFromBytes(bytes)], unsigned);
  const signature = await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  console.log(`sent ${signature}\n  https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  for (let attempt = 1; attempt <= 40; attempt++) {
    const retry = await post('/olp/token', { ...form, payment_id: payment.id, payment_evidence: signature });
    if (retry.status === 200) {
      console.log(`license ${retry.body.license_id} (${retry.body.subject_scope}), expires in ${retry.body.expires_in}s`);
      const check = await post('/olp/introspect', { token: retry.body.access_token, resource });
      console.log(`introspect: active=${check.body.active} permitted=${check.body.permitted}`);
      return;
    }
    const status = retry.body.payment?.status;
    if (retry.status !== 402 || status === 'failed' || status === 'expired') {
      throw new Error(`payment ${status ?? retry.status}: ${retry.body.error_description ?? JSON.stringify(retry.body)}`);
    }
    console.log(`  ${status}… (${attempt})`);
    await sleep(3000);
  }
  throw new Error('gave up waiting for finalization');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
