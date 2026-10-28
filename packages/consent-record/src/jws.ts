/**
 * Signatures of the profile (spec/README.md, "Signing statements"; R7): a compact JWS with
 * a detached, unencoded payload (RFC 7515, RFC 7797) over the RFC 8785 form of a signing
 * statement, with the public key embedded as a JWK and `kid` its RFC 7638 thumbprint.
 * Algorithms and key encodings: RFC 7518 §2, §3.4, §3.5 and §6; RFC 8037 §2; RFC 8032;
 * RFC 9864; RFC 9964 (ML-DSA).
 */
import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { base64url, digestOf, fromBase64url } from './encoding';
import { structureOf } from './ijson';
import { canonicalize } from './jcs';

export type Alg = 'Ed25519' | 'ES256' | 'ES384' | 'ML-DSA-65' | 'PS256';

interface AlgSpec {
  readonly kty: 'AKP' | 'OKP' | 'EC' | 'RSA';
  readonly crv?: string;
  /** Digest for ECDSA and RSASSA-PSS. */
  readonly hash?: 'sha256' | 'sha384';
  /** Bytes of a key coordinate or ML-DSA public key, and of each half of an ECDSA signature. */
  readonly size?: number;
}

const ALGS: Readonly<Record<Alg, AlgSpec>> = {
  Ed25519: { kty: 'OKP', crv: 'Ed25519', size: 32 },
  ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', size: 32 },
  ES384: { kty: 'EC', crv: 'P-384', hash: 'sha384', size: 48 },
  'ML-DSA-65': { kty: 'AKP', size: 1952 },
  PS256: { kty: 'RSA', hash: 'sha256' },
};

const RSA_MIN_BITS = 2048;
/** Larger keys add nothing that matters here and make each verification slower. */
const RSA_MAX_BITS = 4096;
const PSS_SALT_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
/** FIPS 204 signature size for ML-DSA-65 (RFC 9964, Table 1). */
const ML_DSA_65_SIGNATURE_BYTES = 3309;

/** RFC 7638 required members, in the order RFC 7638 §3.2 sorts them; AKP's from RFC 9964 §6. */
const THUMBPRINT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  AKP: ['alg', 'kty', 'pub'],
  EC: ['crv', 'kty', 'x', 'y'],
  OKP: ['crv', 'kty', 'x'],
  RSA: ['e', 'kty', 'n'],
};

/** Private key members (RFC 7518 §6.2.2, §6.3.2, §6.4; RFC 8037 §2; RFC 9964 §3). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k', 'priv'];

/**
 * Why a JWK may not verify signatures, or undefined when it may: it holds no private members,
 * and its `use` and `key_ops`, when present, allow verifying (RFC 7517 §4.2, §4.3).
 */
export function verificationKeyProblem(jwk: Readonly<Record<string, unknown>>): string | undefined {
  if (PRIVATE_MEMBERS.some((name) => Object.hasOwn(jwk, name))) return 'jwk holds private key members';
  if (jwk['use'] !== undefined && jwk['use'] !== 'sig') return 'jwk.use is not "sig"';
  const ops = jwk['key_ops'];
  if (ops !== undefined && !(Array.isArray(ops) && ops.includes('verify'))) return 'jwk.key_ops does not include "verify"';
  return undefined;
}

export function isAlg(alg: unknown): alg is Alg {
  return typeof alg === 'string' && Object.hasOwn(ALGS, alg);
}

/** Whether the JWK's `kty` (and `crv`) fit the algorithm. */
export function algMatchesJwk(alg: Alg, jwk: Readonly<Record<string, unknown>>): boolean {
  const spec = ALGS[alg];
  return jwk['kty'] === spec.kty && (spec.crv === undefined || jwk['crv'] === spec.crv);
}

/**
 * RFC 7638 SHA-256 thumbprint. Throws a TypeError when a required member is missing or not a
 * string.
 */
export function thumbprint(jwk: Readonly<Record<string, unknown>>): string {
  const kty = jwk['kty'];
  const members = typeof kty === 'string' ? THUMBPRINT_MEMBERS[kty] : undefined;
  if (!members || members.some((name) => typeof jwk[name] !== 'string')) {
    throw new TypeError('jwk lacks the members its kty requires');
  }
  return digestOf(Object.fromEntries(members.map((name) => [name, jwk[name]])));
}

export interface SigningStatement {
  readonly profile: string;
  readonly record_uri: string;
  readonly statement: 'agreement' | 'event_instruction' | 'authority_transfer' | 'record_attestation';
  readonly digest: string;
  readonly signer: string;
  readonly signed_at: string;
}

/** The members of a signature object that verification reads. */
export interface SignatureFields {
  readonly alg: string;
  readonly jwk: Readonly<Record<string, unknown>>;
  readonly kid: string;
  readonly value: string;
}

/**
 * Checks a signature against the statement it must cover (verifier steps 1 and 2 of
 * spec/README.md and the key requirements of R7). Returns the problems; empty means valid.
 */
export function verifySignature(sig: SignatureFields, statement: SigningStatement): string[] {
  const parts = sig.value.split('.');
  if (parts.length !== 3 || parts[1] !== '') return ['value is not <header>..<signature>'];
  const [headerB64 = '', , signatureB64 = ''] = parts;
  const problems: string[] = [];
  let header: unknown;
  let duplicates: number;
  try {
    // A byte order mark stays and fails as JSON (RFC 8259 §8.1), as it would in other verifiers.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fromBase64url(headerB64));
    // Read before JSON.parse, which keeps the last of duplicate members (other parsers the
    // first) and takes far more memory than the text when nested deep: such a header is never
    // exact.
    const structure = structureOf(text);
    duplicates = structure.duplicates.length;
    header = structure.deep ? undefined : JSON.parse(text);
  } catch {
    return ['protected header is not base64url JSON'];
  }
  if (duplicates > 0 || !isExactHeader(header, sig.alg, sig.kid)) {
    problems.push('protected header is not exactly {alg, b64: false, crit: ["b64"], kid}');
  }
  try {
    if (thumbprint(sig.jwk) !== sig.kid) problems.push('kid is not the RFC 7638 thumbprint of jwk');
  } catch (error) {
    return [...problems, (error as Error).message];
  }
  if (!isAlg(sig.alg)) return [...problems, `unknown alg ${sig.alg}`];
  let key: KeyObject;
  let signature: Uint8Array;
  try {
    key = publicKeyOf(sig.alg, sig.jwk);
    signature = fromBase64url(signatureB64);
  } catch (error) {
    return [...problems, (error as Error).message];
  }
  const input = Buffer.from(`${headerB64}.${canonicalize(statement)}`, 'utf8');
  if (!verifyBytes(sig.alg, key, signature, input)) problems.push('signature does not verify');
  return problems;
}

function isExactHeader(header: unknown, alg: string, kid: string): boolean {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return false;
  const h = header as Record<string, unknown>;
  const crit = h['crit'];
  return (
    Object.keys(h).length === 4 &&
    h['alg'] === alg &&
    h['b64'] === false &&
    Array.isArray(crit) &&
    crit.length === 1 &&
    crit[0] === 'b64' &&
    h['kid'] === kid
  );
}

/**
 * The public key a JWK holds for `alg`, after checking that the JWK fits the algorithm and
 * is encoded as RFC 7518, RFC 8037 and RFC 9964 require. Throws an Error naming what does
 * not fit.
 */
export function publicKeyOf(alg: Alg, jwk: Readonly<Record<string, unknown>>): KeyObject {
  const spec = ALGS[alg];
  if (!algMatchesJwk(alg, jwk)) throw new Error(`alg ${alg} does not match the jwk`);
  const misuse = verificationKeyProblem(jwk);
  if (misuse !== undefined) throw new Error(misuse);
  const member = (name: string): Uint8Array => {
    const text = jwk[name];
    if (typeof text !== 'string') throw new Error(`jwk.${name} is missing`);
    try {
      return fromBase64url(text);
    } catch {
      throw new Error(`jwk.${name} is not base64url`);
    }
  };
  const size = spec.size ?? 0;
  if (spec.kty === 'AKP') {
    // RFC 9964 §3: an AKP key names its algorithm.
    if (jwk['alg'] !== alg) throw new Error(`alg ${alg} does not match the jwk`);
    const pub = member('pub');
    if (pub.length !== size) throw new Error(`${alg} pub is not ${size} bytes`);
    return importJwk({ kty: 'AKP', alg, pub: base64url(pub) });
  }
  if (spec.kty === 'OKP') {
    const x = member('x');
    if (x.length !== size) throw new Error(`Ed25519 x is not ${size} bytes`);
    if (!isCanonicalY(x)) throw new Error('Ed25519 x is not a canonical point encoding');
    if (hasSmallOrder(x)) throw new Error('Ed25519 key is a point of small order');
    return importJwk({ kty: 'OKP', crv: spec.crv, x: base64url(x) });
  }
  if (spec.kty === 'EC') {
    const x = member('x');
    const y = member('y');
    if (x.length !== size || y.length !== size) throw new Error(`EC coordinates are not ${size} bytes`);
    // Importing rejects a point that is not on the curve.
    return importJwk({ kty: 'EC', crv: spec.crv, x: base64url(x), y: base64url(y) });
  }
  const n = member('n');
  const e = member('e');
  if (n.length === 0 || e.length === 0 || n[0] === 0 || e[0] === 0) {
    throw new Error('RSA n or e is empty or has a leading zero octet');
  }
  // Checked before importing: the cost of verifying grows with the size of n and of e.
  const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]!));
  if (bits < RSA_MIN_BITS || bits > RSA_MAX_BITS) {
    throw new Error(`RSA key has ${bits} bits, not ${RSA_MIN_BITS} to ${RSA_MAX_BITS}`);
  }
  // e is odd and 2^16 < e < 2^31. Without a leading zero octet that means 3 octets (the
  // smallest odd one is 65537) or 4 octets below 0x80, and an odd last octet.
  if (e.length < 3 || e.length > 4 || (e.length === 4 && e[0]! >= 0x80) || (e[e.length - 1]! & 1) === 0) {
    throw new Error('RSA e is not an odd value between 2^16 and 2^31');
  }
  return importJwk({ kty: 'RSA', n: base64url(n), e: base64url(e) });
}

/**
 * The encodings of the eight Ed25519 points of small order (1, 2, 4 or 8), with the sign bit
 * (the top bit of the last byte) cleared, non-canonical ones included: libsodium's list. A
 * key of small order verifies a forged signature for every message, and RFC 8032 does not
 * exclude one.
 */
const ED25519_SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

/** Whether 32 bytes encode an Ed25519 point of small order. */
function hasSmallOrder(point: Uint8Array): boolean {
  const cleared = Buffer.from(point);
  cleared[31] = point[31]! & 0x7f;
  return ED25519_SMALL_ORDER.includes(cleared.toString('hex'));
}

/** Whether 32 bytes encode y below p = 2^255 - 19, as RFC 8032 §5.1.3 decoding requires. */
function isCanonicalY(point: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? point[i]! & 0x7f : point[i]!);
  return y < 2n ** 255n - 19n;
}

function importJwk(jwk: Record<string, string | undefined>): KeyObject {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch (error) {
    throw new Error(`jwk is not a valid public key: ${(error as Error).message}`);
  }
}

function verifyBytes(alg: Alg, key: KeyObject, signature: Uint8Array, input: Uint8Array): boolean {
  const spec = ALGS[alg];
  try {
    if (alg === 'Ed25519') {
      // As libsodium does, no R (the first half) of small order: no honest signer makes one.
      return (
        signature.length === ED25519_SIGNATURE_BYTES &&
        !hasSmallOrder(signature.subarray(0, 32)) &&
        verify(null, input, key, signature)
      );
    }
    if (alg === 'ML-DSA-65') {
      // Pure ML-DSA with an empty context string (RFC 9964 §5), Node's default.
      return signature.length === ML_DSA_65_SIGNATURE_BYTES && verify(null, input, key, signature);
    }
    if (spec.kty === 'EC') {
      return (
        signature.length === 2 * (spec.size ?? 0) &&
        verify(spec.hash ?? null, input, { key, dsaEncoding: 'ieee-p1363' }, signature)
      );
    }
    // RSASSA-PSS with SHA-256; OpenSSL uses the same digest for MGF1.
    return verify(
      'sha256',
      input,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: PSS_SALT_BYTES },
      signature,
    );
  } catch {
    return false;
  }
}
