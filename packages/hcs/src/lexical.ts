/**
 * Lexical checks shared by the conformance rules.
 *
 * RELAX NG applies XML Schema whitespace rules before matching: `xsd:token`, `xsd:anyURI`,
 * `xsd:dateTime`, `xsd:decimal`, `xsd:positiveInteger` and literal values collapse whitespace,
 * while `xsd:string` keeps it. Callers pick the rule that matches the schema's datatype.
 */

/** XML Schema `collapse`: runs of XML whitespace become one space, then trim. */
export function collapse(value: string): string {
  // String.prototype.trim would also strip non-XML whitespace such as U+00A0.
  return value.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '');
}

/** Splits an XML Schema list value into its items. */
export function splitList(value: string): string[] {
  const collapsed = collapse(value);
  return collapsed === '' ? [] : collapsed.split(' ');
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parses an HCS Timestamp (HCS 1.0 Draft §2.1): RFC 3339 `date-time` with an uppercase `T` and
 * `Z`, also valid as the Appendix A `xsd:dateTime` (so no leap second, no hour 24, offsets
 * within ±14:00 and a four-digit year from 0001). Returns milliseconds since the epoch, or
 * undefined. Fractional seconds beyond milliseconds are truncated.
 */
export function parseTimestamp(value: string): number | undefined {
  const match = TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [
    number, number, number, number, number, number,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  let offsetMinutes = 0;
  if (zulu === undefined) {
    const hours = Number(oh);
    const minutes = Number(om);
    if (minutes > 59 || hours > 14 || (hours === 14 && minutes > 0)) return undefined;
    offsetMinutes = (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, fraction ? Math.floor(Number(`0${fraction}`) * 1000) : 0);
  return date.getTime() - offsetMinutes * 60_000;
}

/** An absolute HTTPS URL (`https://.+` in Appendix A, and parseable as a URL). */
export function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/.test(value) && URL.canParse(value);
}

/** A `mailto:` URL with an address (Appendix A `absoluteMailtoURI`). */
export function isMailtoUrl(value: string): boolean {
  return /^mailto:\S+$/.test(value) && URL.canParse(value);
}

/** The RSL `absoluteURI` pattern: a scheme followed by a colon. */
export function isAbsoluteUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/.test(value);
}

/** `xsd:positiveInteger`, after whitespace collapsing. */
export function parsePositiveInteger(value: string): number | undefined {
  if (!/^\+?\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/** `xsd:decimal`, after whitespace collapsing. */
export function isDecimal(value: string): boolean {
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value);
}

/** The RSL `qnameToken` pattern used for extension vocabulary values. */
export function isQName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}
