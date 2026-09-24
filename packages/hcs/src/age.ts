/**
 * Age evidence for the minors rule (HCS 1.0 Draft §1.1).
 *
 * HCS defines no way to tell whether a person is a minor, and the Identity Schema Profile has no
 * age property. Grantmark reads the optional Schema.org `birthDate` from the Rights Subject
 * Record. A partial date (`YYYY` or `YYYY-MM`) is read as the latest day it could mean, so a
 * person is never treated as an adult earlier than they could be.
 */

export type AgeStatus = 'adult' | 'minor' | 'unknown';

export const AGE_OF_MAJORITY = 18;

const SCHEMA_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function latestBirthDate(value: string): Date | undefined {
  const match = SCHEMA_DATE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 12 : Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0); // day 0 of the next month: the last day of this one
  const lastDay = date.getUTCDate();
  const day = match[3] === undefined ? lastDay : Number(match[3]);
  if (day < 1 || day > lastDay) return undefined;
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** Whether a Rights Subject Record shows an adult at `at`. */
export function ageStatus(record: unknown, at: Date): AgeStatus {
  const birthDate =
    typeof record === 'object' && record !== null ? (record as Record<string, unknown>).birthDate : undefined;
  if (typeof birthDate !== 'string') return 'unknown';
  const born = latestBirthDate(birthDate);
  if (born === undefined || born.getTime() > at.getTime()) return 'unknown';

  // setUTCFullYear keeps month and day, so February 29 becomes March 1 in a common year.
  const adultFrom = new Date(born);
  adultFrom.setUTCFullYear(born.getUTCFullYear() + AGE_OF_MAJORITY);
  return at.getTime() >= adultFrom.getTime() ? 'adult' : 'minor';
}
