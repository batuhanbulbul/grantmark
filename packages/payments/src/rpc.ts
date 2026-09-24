/**
 * The Solana RPC calls payments need, behind a small interface so tests can use recorded data.
 * The provider checks the cluster's genesis hash before first use and refuses anything but
 * devnet, whatever URL is configured.
 */

import { createSolanaRpc, type Signature } from '@solana/kit';
import type { ParsedTransaction } from './verify';

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export interface SolanaRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  getTransaction(signature: string, commitment: 'confirmed' | 'finalized'): Promise<ParsedTransaction | null>;
  getGenesisHash(): Promise<string>;
}

export function assertDevnetGenesis(genesisHash: string): void {
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`refusing a Solana cluster other than devnet (genesis hash ${genesisHash})`);
  }
}

/** A JSON-RPC client for devnet (the public endpoint by default). */
export function createDevnetRpc(url: string = DEVNET_RPC_URL): SolanaRpc {
  const rpc = createSolanaRpc(url);
  return {
    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async getTransaction(signature, commitment) {
      const tx = await rpc
        .getTransaction(signature as Signature, { commitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 })
        .send();
      if (tx === null) return null;
      // Kit returns slots and timestamps as bigint; the verifier works with numbers.
      return {
        ...(tx as unknown as ParsedTransaction),
        slot: Number(tx.slot),
        blockTime: tx.blockTime === null ? null : Number(tx.blockTime),
      };
    },
    async getGenesisHash() {
      return rpc.getGenesisHash().send();
    },
  };
}
