import { SignJWT, decodeProtectedHeader, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { KeyStore } from '../src/olp/keys';

const ISSUER = 'https://license.grantmark.example/olp';

describe('KeyStore', () => {
  it('creates one ES256 key on first use and keeps it', async () => {
    const db = openDatabase(':memory:');
    const first = await new KeyStore(db, ISSUER).jwks();
    const again = await new KeyStore(db, ISSUER).jwks();
    expect(first.keys).toHaveLength(1);
    expect(again).toEqual(first);
    expect(first.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(first.keys[0]?.kid).toMatch(/^[\w-]{43}$/);
  });

  it('publishes only the public key', async () => {
    const { keys } = await new KeyStore(openDatabase(':memory:'), ISSUER).jwks();
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('signs tokens it can verify, with the issuer and key id', async () => {
    const store = new KeyStore(openDatabase(':memory:'), ISSUER);
    const token = await store.sign({ jti: 'lic_1', sub: 'demo-studio' }, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: (await store.jwks()).keys[0]?.kid });
    const claims = await store.verify(token, new Date('2026-10-02T00:00:00Z'));
    expect(claims).toMatchObject({ jti: 'lic_1', sub: 'demo-studio', iss: ISSUER });
  });

  it('rejects expired, tampered and foreign tokens', async () => {
    const store = new KeyStore(openDatabase(':memory:'), ISSUER);
    const token = await store.sign({ jti: 'lic_1' }, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
    expect(await store.verify(token, new Date('2026-11-01T00:00:00Z'))).toBeUndefined();

    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify({ jti: 'lic_2', iss: ISSUER })).toString('base64url')}.${signature}`;
    expect(await store.verify(tampered, new Date('2026-10-02T00:00:00Z'))).toBeUndefined();
    expect(payload).toBeDefined();

    const { privateKey } = await generateKeyPair('ES256');
    const foreign = await new SignJWT({ jti: 'lic_1' })
      .setProtectedHeader({ alg: 'ES256', kid: (await store.jwks()).keys[0]!.kid! })
      .setIssuer(ISSUER)
      .sign(privateKey);
    expect(await store.verify(foreign, new Date('2026-10-02T00:00:00Z'))).toBeUndefined();
    expect(await store.verify('not.a.token', new Date('2026-10-02T00:00:00Z'))).toBeUndefined();
  });

  it('rejects tokens from another issuer', async () => {
    const db = openDatabase(':memory:');
    const token = await new KeyStore(db, 'https://other.example/olp').sign({ jti: 'x' }, new Date(), new Date(Date.now() + 60_000));
    expect(await new KeyStore(db, ISSUER).verify(token, new Date())).toBeUndefined();
  });
});
