import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('has development defaults that keep HCS identifiers valid', () => {
    expect(loadConfig({})).toEqual({
      port: 8787,
      databasePath: 'data/grantmark.db',
      publicBaseUrl: 'http://localhost:8787',
      registryId: 'https://registry.grantmark.example',
      licenseServerUrl: 'https://license.grantmark.example/olp',
      adminToken: undefined,
    });
  });

  it('reads the environment and drops a trailing slash from the base URL', () => {
    const config = loadConfig({
      PORT: '9000',
      DATABASE_PATH: '/var/lib/grantmark/db.sqlite',
      PUBLIC_BASE_URL: 'https://grantmark.example.org/',
      REGISTRY_ID: 'https://grantmark.example.org/registry',
      LICENSE_SERVER_URL: 'https://grantmark.example.org/olp',
      ADMIN_TOKEN: 'a-long-enough-admin-token',
    });
    expect(config).toMatchObject({
      port: 9000,
      databasePath: '/var/lib/grantmark/db.sqlite',
      publicBaseUrl: 'https://grantmark.example.org',
      adminToken: 'a-long-enough-admin-token',
    });
  });

  it.each([
    ['a non-numeric port', { PORT: 'eighty' }],
    ['a port out of range', { PORT: '70000' }],
    ['a relative base URL', { PUBLIC_BASE_URL: '/grantmark' }],
    ['an http registry id (HCS §3.1.1 needs https)', { REGISTRY_ID: 'http://registry.example' }],
    ['an http license server URL (HCS §3.1.10 needs https)', { LICENSE_SERVER_URL: 'http://license.example/olp' }],
    ['a short admin token', { ADMIN_TOKEN: 'short' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow();
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ ADMIN_TOKEN: '', PORT: '' })).toMatchObject({ adminToken: undefined, port: 8787 });
  });
});
