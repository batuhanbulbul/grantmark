/**
 * What one check of a record may cost. A record beyond a limit is reported under rule
 * `limit`: not verified, never valid (spec/README.md, "Validation rules beyond JSON
 * Schema"). Past `resolutions`, the key sets and DID URLs left are unchecked instead, so the
 * record is not complete (spec/README.md, "Signing statements", verifier steps 3 and 4).
 * The limits are far above what a record needs; they stop a record built to make the
 * verifier slow or to exhaust its memory.
 */
export const LIMITS = {
  /**
   * Bytes of record text, or of the text a record given as a value would take at least.
   * Parsing JSON can take up to some 70 times its text in memory, so this bounds memory too.
   */
  textBytes: 4 * 1024 * 1024,
  /** Arrays and objects nested in one another. A schema-valid record nests about ten deep. */
  depth: 64,
  /**
   * Steps of the rule checks and the derivation (spec/README.md, "Deriving the state"):
   * events, versions, terms and values looked at, and characters canonicalized. The checks
   * judge each event against the events before it, so a record with thousands of
   * instructions on one term, or thousands of versions, can cost more than this.
   */
  steps: 50_000_000,
  /** Signatures verified: each costs up to about a millisecond, and steps (`signatureSteps`). */
  signatures: 5_000,
  /** Problems reported for one record. A record that has more is reported with the first ones. */
  problems: 100,
  /** Characters of a problem's pointer or message; longer ones are cut. */
  problemChars: 1_000,
  /**
   * Key sets and DID URLs one `verifyRecord` call asks its resolvers for, one after another.
   * A record names a few, but it could name another DID URL in every signature, each one a
   * request; those past this many are left unchecked. The serving authority's key set is
   * asked for first.
   */
  resolutions: 64,
} as const;

/** A check stopped at a limit of `LIMITS`. */
export class LimitError extends Error {}

/** The steps one check has taken, against `LIMITS.steps`. */
export class Work {
  private taken = 0;

  constructor(private readonly budget: number = LIMITS.steps) {}

  /** Counts `n` more steps; throws a `LimitError` once they are more than the budget. */
  spend(n: number): void {
    this.taken += n;
    if (this.taken > this.budget) throw new LimitError(`the checks take more than ${this.budget} steps`);
  }

  /** Counts the steps of making `chars` characters of canonical text, or of comparing them. */
  spendChars(chars: number): void {
    this.spend(Math.ceil(chars / CHARS_PER_STEP));
  }
}

/** Characters of canonical text that cost about as much as one step of the other checks. */
const CHARS_PER_STEP = 8;

/**
 * Steps a comparison key of an effective grant costs. Each value it lists is sorted and
 * written; the canonical text and its SHA-256 take some 10 µs even for a small grant; and each
 * character outside Latin-1 costs some 10 ns to check, write and encode as UTF-8. A check makes
 * many keys from the same long values, so their characters are counted at that rate, not at
 * `CHARS_PER_STEP`.
 */
export const KEY_STEPS = { perValue: 3, perKey: 256, charsPerStep: 2 } as const;

/**
 * Steps one signature verification costs, at the rate of the other steps (some 25 ns each).
 * Measured on Node 24 with the header, thumbprint and key import around each: ES384 some
 * 610 µs, ML-DSA-65 210 µs, PS256 up to 200 µs (4096 bits, an exponent near 2^31), Ed25519
 * and ES256 under 100 µs. The statement's own text is counted apart (`statementSteps`).
 */
export function signatureSteps(alg: string): number {
  if (alg === 'ES384') return 24_000;
  if (alg === 'ML-DSA-65' || alg === 'PS256') return 8_000;
  return 4_000;
}

/**
 * Steps of one pass over a signing statement (writing it, then encoding and hashing it): its
 * `record_uri` and `signer` may be long, and every signature of a record restates them. On
 * Node 24, 2 to 4 ns a character to verify against (ML-DSA-65 the most), 2 ns to digest;
 * charged at 4 characters a step. That rate holds because the `uri` format admits only ASCII
 * characters that JSON writes as they are; one that it escapes, or a wider one, would cost
 * more.
 */
export function statementSteps(statement: { readonly record_uri: string; readonly signer: string }): number {
  return Math.ceil((statement.record_uri.length + statement.signer.length) / 4);
}

/** `text`, cut to `LIMITS.problemChars` characters. */
export function clip(text: string): string {
  return text.length <= LIMITS.problemChars ? text : `${text.slice(0, LIMITS.problemChars)}...`;
}
