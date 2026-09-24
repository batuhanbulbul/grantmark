/**
 * Server configuration from environment variables (see `.env.example`).
 *
 * `REGISTRY_ID` and `LICENSE_SERVER_URL` end up in the `registry` and `server` attributes of the
 * seeded declarations, and HCS requires both to be absolute HTTPS URLs (§3.1.1, §3.1.10). They
 * are identifiers, so local development can keep the defaults while serving plain HTTP.
 */

import { isHttpsUrl } from '@grantmark/hcs';

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

  return {
    port,
    databasePath: read('DATABASE_PATH') ?? DEFAULTS.databasePath,
    publicBaseUrl,
    registryId,
    licenseServerUrl,
    adminToken,
  };
}
