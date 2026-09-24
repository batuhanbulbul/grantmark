/**
 * Browser wallets through the Wallet Standard (Phantom, Solflare, …), without a wallet-adapter
 * framework. The server builds the unsigned devnet transaction; the wallet signs and sends it,
 * so no key ever leaves the wallet.
 */

import type { SolanaSignAndSendTransactionFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { base58 } from './base58';

export const DEVNET_CHAIN = 'solana:devnet';
const CONNECT = 'standard:connect';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

type ConnectFeature = { [CONNECT]: { connect(): Promise<{ accounts: readonly WalletAccount[] }> } };

export function solanaWallets(wallets: readonly Wallet[]): Wallet[] {
  return wallets.filter(
    (wallet) => CONNECT in wallet.features && SIGN_AND_SEND in wallet.features && wallet.chains.some((chain) => chain.startsWith('solana:')),
  );
}

/** The Solana wallets installed in this browser. */
export function installedWallets(): Wallet[] {
  return solanaWallets(getWallets().get());
}

export async function connectWallet(wallet: Wallet): Promise<WalletAccount> {
  const { accounts } = await (wallet.features as unknown as ConnectFeature)[CONNECT].connect();
  const account = accounts[0];
  if (account === undefined) throw new Error(`${wallet.name} did not share an account`);
  return account;
}

/** Signs and sends a base64 wire transaction on devnet; returns the base58 signature. */
export async function signAndSendTransaction(wallet: Wallet, account: WalletAccount, transactionBase64: string): Promise<string> {
  const feature = (wallet.features as unknown as SolanaSignAndSendTransactionFeature)[SIGN_AND_SEND];
  const transaction = Uint8Array.from(atob(transactionBase64), (char) => char.charCodeAt(0));
  const [result] = await feature.signAndSendTransaction({
    account,
    chain: DEVNET_CHAIN,
    transaction,
    options: { commitment: 'confirmed' },
  });
  if (result === undefined) throw new Error('the wallet returned no signature');
  return base58(result.signature);
}
