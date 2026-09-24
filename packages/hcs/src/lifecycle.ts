/**
 * Lifecycle and revalidation rules (HCS 1.0 Draft §3.1.7 and §3.1.8) for a conforming
 * declaration at a given time.
 */

import type { Declaration, Finding } from './conformance';

export const DEFAULT_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type LifecycleCode =
  | 'withdrawn'
  | 'superseded'
  | 'invalid_validity_period'
  | 'not_yet_in_force'
  | 'expired'
  | 'revalidation_required';

export interface LifecycleContext {
  /** The time of the use being evaluated. */
  readonly at: Date;
  /**
   * When the declaration and the records it relies on were last validated. Defaults to `at`,
   * meaning they were just retrieved.
   */
  readonly validatedAt?: Date | undefined;
  /**
   * The earliest time the current terms are known to have been available at the official
   * publication location: from registry history if known, otherwise the time this system first
   * observed them. The declaration is not in force before it (§3.1.7.2, first-observation rule).
   */
  readonly availableSince?: Date | undefined;
}

export interface LifecycleResult {
  /** Every failed rule. Any reason makes the declaration non-operative at `at`. */
  readonly reasons: readonly Finding<LifecycleCode>[];
  /** Start of the in-force period after applying `availableSince`. */
  readonly inForceFrom: Date;
  /** Exclusive end of the in-force period (`valid-until`), if any. */
  readonly inForceUntil?: Date | undefined;
  /** When the effective max-age runs out and the declaration must be revalidated. */
  readonly revalidateBy: Date;
}

/** `max-age` from `<rsl>` and `<hcs:right>`: whichever is present, the smaller of both, or 30. */
export function effectiveMaxAgeDays(declaration: Declaration): number {
  const values = [declaration.maxAge, declaration.documentMaxAge].filter((v) => v !== undefined);
  return values.length === 0 ? DEFAULT_MAX_AGE_DAYS : Math.min(...values);
}

export function checkLifecycle(declaration: Declaration, context: LifecycleContext): LifecycleResult {
  const reasons: Finding<LifecycleCode>[] = [];
  const add = (code: LifecycleCode, rule: string, at: string, message: string) => {
    reasons.push({ code, rule, at, message });
  };
  const t = context.at.getTime();
  const { issued, validFrom, validUntil, status } = declaration;

  if (status === 'withdrawn') {
    add('withdrawn', 'HCS §3.1.7.1', '@status', 'the declaration has been withdrawn');
  } else if (status === 'superseded') {
    add('superseded', 'HCS §3.1.7.1', '@status', `the declaration is superseded by ${declaration.supersededBy.join(', ')}`);
  }

  const declaredStart = validFrom ?? issued;
  const start = Math.max(declaredStart.time, context.availableSince?.getTime() ?? -Infinity);
  if (validFrom !== undefined && validFrom.time < issued.time) {
    add('invalid_validity_period', 'HCS §3.1.7.2', '@valid-from', 'valid-from precedes issued, so the declaration is never in force');
  } else if (validUntil !== undefined && validUntil.time <= declaredStart.time) {
    add('invalid_validity_period', 'HCS §3.1.7.2', '@valid-until', 'valid-until is not later than the start, so the declaration is never in force');
  } else if (t < start) {
    add('not_yet_in_force', 'HCS §3.1.7.2', '@valid-from', `the declaration is in force from ${new Date(start).toISOString()}`);
  } else if (validUntil !== undefined && t >= validUntil.time) {
    add('expired', 'HCS §3.1.7.2', '@valid-until', `the declaration ended at ${validUntil.text} (exclusive)`);
  }

  const maxAgeDays = effectiveMaxAgeDays(declaration);
  const revalidateBy = new Date((context.validatedAt ?? context.at).getTime() + maxAgeDays * DAY_MS);
  if (t >= revalidateBy.getTime()) {
    add('revalidation_required', 'HCS §3.1.8', '@max-age', `the ${maxAgeDays}-day revalidation period has elapsed`);
  }

  return {
    reasons,
    inForceFrom: new Date(start),
    inForceUntil: validUntil === undefined ? undefined : new Date(validUntil.time),
    revalidateBy,
  };
}
