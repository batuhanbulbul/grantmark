/**
 * Public types of the verifier for the consent authority record profile (spec/README.md,
 * draft 0.2.0). Rule ids are those of "Validation rules beyond JSON Schema" in that file.
 */

/**
 * `schema`: the JSON Schema (`spec/consent-authority-record.schema.json`), formats asserted.
 * `R0`–`R20`: the validation rules of spec/README.md.
 * `limit`: the record is beyond a limit of this verifier (its size, its nesting, or the work
 * the checks take), so it was not checked to the end. The record is then reported invalid.
 * `internal`: the verifier failed on this input. The record is then reported invalid.
 */
export type RuleId =
  | 'schema'
  | 'R0'
  | 'R1'
  | 'R2'
  | 'R3'
  | 'R4'
  | 'R5'
  | 'R6'
  | 'R7'
  | 'R8'
  | 'R9'
  | 'R10'
  | 'R11'
  | 'R12'
  | 'R13'
  | 'R14'
  | 'R15'
  | 'R16'
  | 'R17'
  | 'R18'
  | 'R19'
  | 'R20'
  | 'limit'
  | 'internal';

export interface Problem {
  readonly rule: RuleId;
  /**
   * JSON Pointer (RFC 6901) into the record, e.g. `/agreements/0/signatures/1`; `''` is the
   * whole record.
   */
  readonly at: string;
  readonly message: string;
}

/** A public JWK (RFC 7517) as the record carries it. */
export type Jwk = Readonly<Record<string, unknown>> & { readonly kty: string };

/** A JWK Set (RFC 7517 §5). */
export interface JwkSet {
  readonly keys: readonly Jwk[];
}

/**
 * A check that needs data from outside the record (spec/README.md, "Signing statements",
 * verifier steps 3 and 4). `at` points to the signature object.
 */
export type ExternalCheck =
  /**
   * The signer is an authority: `kid` must be listed, with this key, in the key set at
   * `keysUri`.
   */
  | {
      readonly kind: 'authority_key_set';
      readonly at: string;
      readonly signer: string;
      readonly keysUri: string;
      readonly kid: string;
      readonly jwk: Jwk;
    }
  /** `did_url` must resolve to a verification method holding this key. */
  | {
      readonly kind: 'did';
      readonly at: string;
      readonly didUrl: string;
      readonly kid: string;
      readonly jwk: Jwk;
    }
  /**
   * The certificate chain: leaf holds the key, chains to a trusted anchor, valid and not
   * revoked at `signedAt`, tied to the signer's identifier.
   */
  | {
      readonly kind: 'x509';
      readonly at: string;
      readonly x5c: readonly string[];
      readonly signedAt: string;
      readonly kid: string;
      readonly jwk: Jwk;
    }
  /** An RFC 3161 time-stamp token over the signature. */
  | {
      readonly kind: 'timestamp_token';
      readonly at: string;
      readonly token: string;
    };

/** Result of the offline check: everything the record itself can prove. */
export interface CheckResult {
  /** `full` when the record carries `disclosures`, else `public`. */
  readonly view: 'full' | 'public';
  /** The record has `example: true`; it conveys no consent even when valid. */
  readonly example: boolean;
  /** Empty when the record passes the schema and R0–R20. */
  readonly problems: readonly Problem[];
  /** Checks that need outside data. Listed only when `problems` is empty. */
  readonly external: readonly ExternalCheck[];
}

/**
 * Sources of outside data. A resolver returns `undefined` when it cannot get the data.
 * `verifyRecord` calls it once per key set or DID URL, and makes at most `LIMITS.resolutions`
 * calls in all, key sets and DID URLs together (the serving authority's key set first, then
 * other key sets, then DID URLs). It waits for each call in turn and sets no time limit, so a
 * resolver that goes to the network needs its own timeout and a bound on the size of what it
 * fetches. A call that throws, or rejects, leaves the checks that need its answer unchecked. A
 * record may name many verification methods of one DID, so a DID resolver should fetch each
 * DID document once.
 */
export interface Resolvers {
  /** The JWK Set published at `keysUri`. */
  readonly keySet?: (keysUri: string) => Promise<JwkSet | undefined>;
  /** The public key of the verification method that `didUrl` names. */
  readonly did?: (didUrl: string) => Promise<Jwk | undefined>;
}

export interface Unchecked {
  readonly check: ExternalCheck;
  /**
   * Why it was not checked, e.g. no resolver, the resolver returned nothing, more key sets and
   * DID URLs than `LIMITS.resolutions`, not supported.
   */
  readonly reason: string;
}

export interface VerifyResult {
  readonly view: 'full' | 'public';
  readonly example: boolean;
  /** No problem was found: offline, or by an external check that ran. */
  readonly valid: boolean;
  /** `valid`, and every external check ran. Only then is the record fully verified. */
  readonly complete: boolean;
  /**
   * Offline problems, then problems from external checks (key set and DID mismatches: R7, or
   * R20 for the attestation); at most `LIMITS.problems`.
   */
  readonly problems: readonly Problem[];
  readonly unchecked: readonly Unchecked[];
}
