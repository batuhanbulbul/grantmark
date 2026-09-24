import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { describe, expect, it } from 'vitest';
import { DEVNET_CHAIN, connectWallet, signAndSendTransaction, solanaWallets } from '../src/wallet';

const account = { address: '9Qt7tfh823nacfZWuRcopkM399JtzELspLTEZW3qMk3t', publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: [] } as unknown as WalletAccount;

function fakeWallet(name: string, features: Record<string, unknown>, chains = ['solana:mainnet', 'solana:devnet']): Wallet {
  return { version: '1.0.0', name, icon: 'data:image/svg+xml;base64,', chains, features, accounts: [] } as unknown as Wallet;
}

describe('solanaWallets', () => {
  it('keeps wallets that can connect and sign-and-send Solana transactions', () => {
    const complete = fakeWallet('Complete', { 'standard:connect': {}, 'solana:signAndSendTransaction': {} });
    const noSend = fakeWallet('NoSend', { 'standard:connect': {} });
    const noSolana = fakeWallet('Eth', { 'standard:connect': {}, 'solana:signAndSendTransaction': {} }, ['eip155:1']);
    expect(solanaWallets([complete, noSend, noSolana]).map((w) => w.name)).toEqual(['Complete']);
  });
});

describe('connectWallet and signAndSendTransaction', () => {
  it('connects, then signs and sends the server-built transaction on devnet', async () => {
    const calls: unknown[] = [];
    const wallet = fakeWallet('Complete', {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: async (...inputs: unknown[]) => {
          calls.push(...inputs);
          return [{ signature: new Uint8Array([0, 0, 1]) }];
        },
      },
    });
    expect(await connectWallet(wallet)).toBe(account);
    const signature = await signAndSendTransaction(wallet, account, btoa(String.fromCharCode(1, 2, 3)));
    expect(signature).toBe('112');
    expect(calls).toEqual([{ account, chain: DEVNET_CHAIN, transaction: new Uint8Array([1, 2, 3]), options: { commitment: 'confirmed' } }]);
  });

  it('fails clearly when the wallet returns no account', async () => {
    const wallet = fakeWallet('Empty', { 'standard:connect': { connect: async () => ({ accounts: [] }) }, 'solana:signAndSendTransaction': {} });
    await expect(connectWallet(wallet)).rejects.toThrow(/account/);
  });
});
