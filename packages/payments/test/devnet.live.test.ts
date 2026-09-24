// Read-only checks against the public devnet RPC. They run only with GRANTMARK_LIVE_DEVNET=1,
// so CI and offline runs skip them.

import { describe, expect, it } from 'vitest';
import { DEVNET_GENESIS_HASH, createDevnetRpc } from '../src/rpc';
import { verifyTransfer } from '../src/verify';

const RECORDED_SIGNATURE = '3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg';

describe.skipIf(process.env.GRANTMARK_LIVE_DEVNET !== '1')('live devnet RPC', () => {
  const rpc = createDevnetRpc();

  it('is devnet', async () => {
    expect(await rpc.getGenesisHash()).toBe(DEVNET_GENESIS_HASH);
  });

  it('returns a recent blockhash', async () => {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    expect(blockhash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(lastValidBlockHeight).toBeGreaterThan(0n);
  });

  it('reads and verifies the recorded payment', async () => {
    const tx = await rpc.getTransaction(RECORDED_SIGNATURE, 'finalized');
    const blockTime = new Date(1790215241 * 1000);
    const result = verifyTransfer(tx, {
      memo: '1584b551-8204-4a2d-b924-5b0d32c0c3d8',
      transfers: [{ tokenAccount: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3', amount: 1000n }],
      notBefore: new Date(blockTime.getTime() - 60_000),
      notAfter: new Date(blockTime.getTime() + 60_000),
    });
    expect(result.ok).toBe(true);
  });
});
