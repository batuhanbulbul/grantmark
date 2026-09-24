import { describe, expect, it } from 'vitest';
import {
  collapse,
  isAbsoluteUri,
  isDecimal,
  isHttpsUrl,
  isMailtoUrl,
  isQName,
  parsePositiveInteger,
  parseTimestamp,
  splitList,
} from '../src/lexical';

describe('collapse / splitList (XML Schema whitespace)', () => {
  it('collapses runs of XML whitespace and trims', () => {
    expect(collapse('  a \t\r\n b  ')).toBe('a b');
    expect(collapse('')).toBe('');
  });

  it('does not treat other Unicode spaces as XML whitespace', () => {
    expect(collapse(' a ')).toBe(' a ');
  });

  it('splits lists on XML whitespace', () => {
    expect(splitList(' image\tlikeness\n image ')).toEqual(['image', 'likeness', 'image']);
    expect(splitList(' \n ')).toEqual([]);
  });
});

describe('parseTimestamp (HCS 1.0 Draft §2.1)', () => {
  it.each([
    ['2026-01-01T00:00:00Z', Date.UTC(2026, 0, 1)],
    ['2026-01-01T03:00:00+03:00', Date.UTC(2026, 0, 1)],
    ['2025-12-31T19:30:00-04:30', Date.UTC(2026, 0, 1)],
    ['2026-01-01T00:00:00.5Z', Date.UTC(2026, 0, 1, 0, 0, 0, 500)],
    ['2026-01-01T00:00:00.123456Z', Date.UTC(2026, 0, 1, 0, 0, 0, 123)],
    ['2024-02-29T12:00:00-00:00', Date.UTC(2024, 1, 29, 12)],
    ['2026-01-01T00:00:00+14:00', Date.UTC(2025, 11, 31, 10)],
  ])('accepts %s', (text, time) => {
    expect(parseTimestamp(text)).toBe(time);
  });

  it('handles years below 100 without the Date.UTC century shift', () => {
    expect(new Date(parseTimestamp('0099-06-01T00:00:00Z')!).getUTCFullYear()).toBe(99);
  });

  it.each([
    ['lowercase t', '2026-01-01t00:00:00Z'],
    ['lowercase z', '2026-01-01T00:00:00z'],
    ['space separator', '2026-01-01 00:00:00Z'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['date only', '2026-01-01'],
    ['no seconds', '2026-01-01T00:00Z'],
    ['compact offset', '2026-01-01T00:00:00+0300'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['February 30', '2026-02-30T00:00:00Z'],
    ['February 29 in a common year', '2026-02-29T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['leap second (not allowed by xsd:dateTime)', '2026-06-30T23:59:60Z'],
    ['offset beyond 14:00', '2026-01-01T00:00:00+14:30'],
    ['year 0000', '0000-01-01T00:00:00Z'],
    ['five-digit year', '12026-01-01T00:00:00Z'],
    ['surrounding whitespace', ' 2026-01-01T00:00:00Z'],
  ])('rejects %s', (_label, text) => {
    expect(parseTimestamp(text)).toBeUndefined();
  });
});

describe('URL checks', () => {
  it('isHttpsUrl requires an absolute, parseable https URL', () => {
    expect(isHttpsUrl('https://registry.example')).toBe(true);
    expect(isHttpsUrl('https://registry.example/a?b=c#d')).toBe(true);
    expect(isHttpsUrl('http://registry.example')).toBe(false);
    expect(isHttpsUrl('HTTPS://registry.example')).toBe(false);
    expect(isHttpsUrl('https://')).toBe(false);
    expect(isHttpsUrl('https://bad host')).toBe(false);
    expect(isHttpsUrl('/relative')).toBe(false);
  });

  it('isMailtoUrl requires a mailto URL with an address', () => {
    expect(isMailtoUrl('mailto:rights@example.com')).toBe(true);
    expect(isMailtoUrl('mailto:')).toBe(false);
    expect(isMailtoUrl('rights@example.com')).toBe(false);
  });

  it('isAbsoluteUri follows the RSL absoluteURI pattern', () => {
    expect(isAbsoluteUri('urn:example:x')).toBe(true);
    expect(isAbsoluteUri('https://example.com')).toBe(true);
    expect(isAbsoluteUri('/path')).toBe(false);
    expect(isAbsoluteUri('1abc:x')).toBe(false);
  });
});

describe('number and name checks', () => {
  it('parsePositiveInteger follows xsd:positiveInteger', () => {
    expect(parsePositiveInteger('30')).toBe(30);
    expect(parsePositiveInteger('+7')).toBe(7);
    expect(parsePositiveInteger('007')).toBe(7);
    expect(parsePositiveInteger('0')).toBeUndefined();
    expect(parsePositiveInteger('-1')).toBeUndefined();
    expect(parsePositiveInteger('1.0')).toBeUndefined();
    expect(parsePositiveInteger('')).toBeUndefined();
  });

  it('isDecimal follows xsd:decimal', () => {
    for (const ok of ['5', '5.00', '-1.5', '+2', '.5', '5.']) expect(isDecimal(ok), ok).toBe(true);
    for (const bad of ['', '.', '1e3', '1,5', 'five']) expect(isDecimal(bad), bad).toBe(false);
  });

  it('isQName matches the RSL extension token pattern', () => {
    expect(isQName('ext:token')).toBe(true);
    expect(isQName('hcs:ai-generate')).toBe(true);
    expect(isQName('token')).toBe(false);
    expect(isQName('a:b:c')).toBe(false);
  });
});
