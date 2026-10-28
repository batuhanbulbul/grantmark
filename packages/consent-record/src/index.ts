/**
 * Verifier for the consent authority record profile, draft 0.2.0 (spec/README.md). It checks
 * a record against the JSON Schema and the validation rules R0–R20: signatures, digests,
 * the event chain, the derived state and the disclosures. Checks that need outside data
 * (authority key sets, DIDs, X.509 chains, time-stamp tokens) are listed, and run when a
 * resolver is given; a record is fully verified only when none is left unchecked.
 */
export type {
  CheckResult,
  ExternalCheck,
  Jwk,
  JwkSet,
  Problem,
  Resolvers,
  RuleId,
  Unchecked,
  VerifyResult,
} from './types';

/**
 * Offline check of a parsed record. Never throws; a failure inside the verifier, or a value
 * whose reading throws (a getter, a Proxy), is a problem with rule `internal`. R0 is checked on
 * the values only (surrogate and noncharacter code points): duplicate member names and UTF-8
 * need the text, see `checkRecordText`. Rules run only on a record that passes R0 and the
 * schema.
 */
export { checkRecord } from './check';

/**
 * Offline check of a record given as text: R0 on the text (UTF-8, duplicate member names), then
 * `checkRecord`. Never throws.
 */
export { checkRecordText } from './check';

/**
 * `checkRecord` (or `checkRecordText` for a string or bytes), then the external checks the
 * resolvers can run. X.509 chains and time-stamp tokens are not checked in this version and
 * always appear in `unchecked`. Never rejects.
 */
export { verifyRecord } from './verify';

/**
 * The public view: the record without `disclosures`. Returns a new object that shares the
 * record's other members.
 */
export { toPublicView } from './check';

/** What one check may cost; a record beyond a limit gets a problem with rule `limit`. */
export { LIMITS } from './limits';

/**
 * RFC 8785 (JCS) serialization. Throws a `TypeError` for a value that is not I-JSON
 * (RFC 7493): a non-finite number, a string or member name with a surrogate or
 * noncharacter code point, or anything other than JSON values (objects, arrays, strings,
 * finite numbers, booleans, null). A value nested deeper than the call stack allows throws
 * a `RangeError`.
 */
export { canonicalize } from './jcs';
