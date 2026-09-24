import { describe, expect, it } from 'vitest';
import { ageStatus } from '../src/age';

const on = (iso: string) => new Date(iso);
const record = (birthDate?: unknown) => ({ '@type': 'Person', ...(birthDate === undefined ? {} : { birthDate }) });

describe('ageStatus', () => {
  it('turns adult on the 18th birthday, not before', () => {
    expect(ageStatus(record('2008-10-12'), on('2026-10-11T23:59:59Z'))).toBe('minor');
    expect(ageStatus(record('2008-10-12'), on('2026-10-12T00:00:00Z'))).toBe('adult');
  });

  it('handles a February 29 birthday in a common year', () => {
    expect(ageStatus(record('2008-02-29'), on('2026-02-28T12:00:00Z'))).toBe('minor');
    expect(ageStatus(record('2008-02-29'), on('2026-03-01T00:00:00Z'))).toBe('adult');
  });

  it('assumes the latest possible birth date for a partial date', () => {
    expect(ageStatus(record('2008-10'), on('2026-10-30T00:00:00Z'))).toBe('minor');
    expect(ageStatus(record('2008-10'), on('2026-10-31T00:00:00Z'))).toBe('adult');
    expect(ageStatus(record('2008'), on('2026-12-30T00:00:00Z'))).toBe('minor');
    expect(ageStatus(record('2008'), on('2026-12-31T00:00:00Z'))).toBe('adult');
  });

  it('is unknown without a usable birthDate', () => {
    expect(ageStatus(record(), on('2026-10-12T00:00:00Z'))).toBe('unknown');
    expect(ageStatus(record('12 March 1994'), on('2026-10-12T00:00:00Z'))).toBe('unknown');
    expect(ageStatus(record('1994-13-01'), on('2026-10-12T00:00:00Z'))).toBe('unknown');
    expect(ageStatus(record(['1994-01-01']), on('2026-10-12T00:00:00Z'))).toBe('unknown');
    expect(ageStatus(record('2030-01-01'), on('2026-10-12T00:00:00Z'))).toBe('unknown');
    expect(ageStatus(undefined, on('2026-10-12T00:00:00Z'))).toBe('unknown');
  });
});
