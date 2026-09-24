import { describe, expect, it } from 'vitest';
import { base58 } from '../src/base58';
import { decisionLabel, formatAmount, shortHash, usageLabel, verdictLabel } from '../src/format';

describe('base58', () => {
  it.each([
    [[], ''],
    [[0], '1'],
    [[0, 0, 1], '112'],
    [[...new TextEncoder().encode('hello world')], 'StV1DL6CwTryKyV'],
    [[255, 255], 'LUv'],
  ])('encodes %j as "%s"', (bytes, expected) => {
    expect(base58(new Uint8Array(bytes))).toBe(expected);
  });
});

describe('labels', () => {
  it('names evaluator decisions the way the Human Consent Registry does', () => {
    expect(decisionLabel('permitted')).toBe('Permitted');
    expect(decisionLabel('permitted_with_terms')).toBe('Permitted with terms');
    expect(decisionLabel('prohibited')).toBe('Prohibited');
    expect(decisionLabel('not_determinable')).toBe('No permission');
  });

  it('names verification verdicts', () => {
    expect(verdictLabel('licensed')).toBe('Licensed');
    expect(verdictLabel('licensed_before_change')).toBe('Licensed before a change');
    expect(verdictLabel('tampered')).toBe('Changed after stamping');
    expect(verdictLabel('no_credentials')).toBe('No Content Credentials');
    expect(verdictLabel('unknown_authority')).toBe('Unknown consent authority');
  });

  it('names usage tokens', () => {
    expect(usageLabel('hcs:ai-generate')).toBe('AI generation');
    expect(usageLabel('hcs:ai-train')).toBe('AI training');
    expect(usageLabel('other')).toBe('other');
  });

  it('formats amounts and hashes', () => {
    expect(formatAmount({ value: '5.00', currency: 'USD' })).toBe('$5.00');
    expect(formatAmount({ value: '5', currency: 'USD' })).toBe('$5.00');
    expect(formatAmount({ value: '2.5', currency: 'EUR' })).toBe('2.50 EUR');
    expect(formatAmount(null)).toBe('Free');
    expect(shortHash('3dfrHDr5si57QTrXMR2w6Q33Np1A2EudDEU2WebaXjuz1y8KT9A8UokSCJD3XCr1rvaRBhJ88o4x7GKSxVMUygPg')).toBe('3dfrHD…MUygPg');
    expect(shortHash('short')).toBe('short');
  });
});
