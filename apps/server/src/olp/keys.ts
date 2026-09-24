/**
 * The license server's ES256 signing key, created on first use and kept in the database (which
 * is never committed). Its public half is published as a JWKS so resource servers can verify
 * License tokens offline.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';

/** jose's WebCrypto key type; Node's typings have no global CryptoKey type. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface SigningKey {
  readonly kid: string;
  readonly privateKey: PrivateKey;
  readonly publicJwk: JWK;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** JWS `typ` of license receipts. */
export const RECEIPT_TYPE = 'grantmark-receipt+jwt';

export class KeyStore {
  private readonly db: DatabaseSync;
  private readonly issuer: string;
  private readonly now: () => Date;
  private key: Promise<SigningKey> | undefined;

  constructor(db: DatabaseSync, issuer: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.issuer = issuer;
    this.now = now;
  }

  private signingKey(): Promise<SigningKey> {
    this.key ??= this.loadOrCreate();
    return this.key;
  }

  private async loadOrCreate(): Promise<SigningKey> {
    const row = this.db.prepare('SELECT * FROM signing_keys WHERE active = 1 ORDER BY created_at LIMIT 1').get() as
      | { kid: string; private_jwk: string; public_jwk: string }
      | undefined;
    if (row !== undefined) {
      const privateKey = (await importJWK(JSON.parse(row.private_jwk) as JWK, 'ES256')) as PrivateKey;
      return { kid: row.kid, privateKey, publicJwk: JSON.parse(row.public_jwk) as JWK };
    }

    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const exported = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(exported);
    const publicJwk: JWK = { ...exported, kid, alg: 'ES256', use: 'sig' };
    this.db
      .prepare('INSERT INTO signing_keys (kid, private_jwk, public_jwk, created_at, active) VALUES (?, ?, ?, ?, 1)')
      .run(kid, JSON.stringify(await exportJWK(privateKey)), JSON.stringify(publicJwk), this.now().toISOString());
    return { kid, privateKey, publicJwk };
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    return { keys: [(await this.signingKey()).publicJwk] };
  }

  async sign(claims: JWTPayload, issuedAt: Date, expiresAt: Date): Promise<string> {
    const { kid, privateKey } = await this.signingKey();
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setIssuedAt(seconds(issuedAt))
      .setExpirationTime(seconds(expiresAt))
      .sign(privateKey);
  }

  /**
   * A public receipt: no expiry, and a distinct `typ` so it can never pass as an access token.
   */
  async signReceipt(claims: JWTPayload, issuedAt: Date): Promise<string> {
    const { kid, privateKey } = await this.signingKey();
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid, typ: RECEIPT_TYPE })
      .setIssuer(this.issuer)
      .setIssuedAt(seconds(issuedAt))
      .sign(privateKey);
  }

  /** The claims of a receipt signed by this server, or undefined. */
  async verifyReceipt(receipt: string): Promise<JWTPayload | undefined> {
    try {
      const { payload } = await jwtVerify(receipt, createLocalJWKSet(await this.jwks()), {
        issuer: this.issuer,
        algorithms: ['ES256'],
        typ: RECEIPT_TYPE,
      });
      return payload;
    } catch {
      return undefined;
    }
  }

  /** The verified claims, or undefined for any invalid, expired or foreign token. */
  async verify(token: string, at: Date): Promise<JWTPayload | undefined> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(await this.jwks()), {
        issuer: this.issuer,
        algorithms: ['ES256'],
        typ: 'JWT',
        requiredClaims: ['exp'],
        currentDate: at,
      });
      return payload;
    } catch {
      return undefined;
    }
  }
}
