/**
 * Server configuration from environment variables (see `.env.example`).
 *
 * `REGISTRY_ID` and `LICENSE_SERVER_URL` end up in the `registry` and `server` attributes of the
 * seeded declarations, and HCS requires both to be absolute HTTPS URLs (§3.1.1, §3.1.10). They
 * are identifiers, so local development can keep the defaults while serving plain HTTP.
 */

import { isHttpsUrl } from '@grantmark/hcs';
import { DEVNET_RPC_URL, isSolanaAddress } from '@grantmark/payments';

export interface Config {
  readonly port: number;
  readonly databasePath: string;
  /** Where this server is reachable, without a trailing slash. */
  readonly publicBaseUrl: string;
  /** The mock registry's identifier, used as the HCS `registry` attribute. */
  readonly registryId: string;
  /** The license server URL, used as the HCS `server` attribute. */
  readonly licenseServerUrl: string;
  /** Enables the demo admin endpoints when set. */
  readonly adminToken?: string | undefined;
  /** Solana JSON-RPC endpoint; payments refuse any cluster but devnet. */
  readonly solanaRpcUrl: string;
  /** Wallet that receives the fee of whoever operates this server; none when unset. */
  readonly operatorWallet?: string | undefined;
  /** Operator fee in basis points of each payment; 0 without an operator wallet. */
  readonly operatorFeeBps: number;
  /** The OLP client the demo web app acts as (server side). */
  readonly demoClientId: string;
  /** Requests per minute and client address on the public, expensive endpoints. */
  readonly rateLimitPerMinute: number;
  /** Whether to take the client address from X-Forwarded-For (only behind a trusted proxy). */
  readonly trustProxy: boolean;
}

const DEFAULTS = {
  port: 8787,
  databasePath: 'data/grantmark.db',
  publicBaseUrl: 'http://localhost:8787',
  registryId: 'https://registry.grantmark.example',
  licenseServerUrl: 'https://license.grantmark.example/olp',
};

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const read = (name: string) => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  const fail = (message: string): never => {
    throw new Error(`Invalid configuration: ${message}`);
  };

  const portText = read('PORT');
  const port = portText === undefined ? DEFAULTS.port : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be an integer from 1 to 65535, found "${portText}"`);

  const publicBaseUrl = (read('PUBLIC_BASE_URL') ?? DEFAULTS.publicBaseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicBaseUrl) || !URL.canParse(publicBaseUrl)) {
    fail(`PUBLIC_BASE_URL must be an absolute http(s) URL, found "${publicBaseUrl}"`);
  }

  const registryId = read('REGISTRY_ID') ?? DEFAULTS.registryId;
  if (!isHttpsUrl(registryId)) fail(`REGISTRY_ID must be an absolute HTTPS URL, found "${registryId}"`);

  const licenseServerUrl = read('LICENSE_SERVER_URL') ?? DEFAULTS.licenseServerUrl;
  if (!isHttpsUrl(licenseServerUrl)) fail(`LICENSE_SERVER_URL must be an absolute HTTPS URL, found "${licenseServerUrl}"`);

  const adminToken = read('ADMIN_TOKEN');
  if (adminToken !== undefined && adminToken.length < 16) fail('ADMIN_TOKEN must be at least 16 characters');

  const solanaRpcUrl = read('SOLANA_RPC_URL') ?? DEVNET_RPC_URL;
  if (!isHttpsUrl(solanaRpcUrl)) fail(`SOLANA_RPC_URL must be an absolute HTTPS URL, found "${solanaRpcUrl}"`);

  const operatorWallet = read('OPERATOR_WALLET');
  if (operatorWallet !== undefined && !isSolanaAddress(operatorWallet)) fail('OPERATOR_WALLET must be a Solana address');
  const feeText = read('OPERATOR_FEE_BPS');
  if (feeText !== undefined && operatorWallet === undefined) fail('OPERATOR_FEE_BPS needs OPERATOR_WALLET');
  const operatorFeeBps = operatorWallet === undefined ? 0 : Number(feeText ?? 1000);
  if (!Number.isInteger(operatorFeeBps) || operatorFeeBps < 0 || operatorFeeBps > 5000) {
    fail(`OPERATOR_FEE_BPS must be an integer from 0 to 5000, found "${feeText}"`);
  }

  const rateText = read('RATE_LIMIT_PER_MINUTE');
  const rateLimitPerMinute = rateText === undefined ? 60 : Number(rateText);
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
    fail(`RATE_LIMIT_PER_MINUTE must be a positive integer, found "${rateText}"`);
  }

  return {
    port,
    databasePath: read('DATABASE_PATH') ?? DEFAULTS.databasePath,
    publicBaseUrl,
    registryId,
    licenseServerUrl,
    adminToken,
    solanaRpcUrl,
    operatorWallet,
    operatorFeeBps,
    demoClientId: read('DEMO_CLIENT_ID') ?? 'demo-studio',
    rateLimitPerMinute,
    trustProxy: ['1', 'true'].includes(read('TRUST_PROXY') ?? ''),
  };
}
