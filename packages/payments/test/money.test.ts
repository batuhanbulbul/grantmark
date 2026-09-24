import { describe, expect, it } from 'vitest';
import { fromBaseUnits, splitAmount, toBaseUnits } from '../src/money';

describe('toBaseUnits', () => {
  it.each([
    ['5.00', 5_000_000n],
    ['5', 5_000_000n],
    ['0.000001', 1n],
    ['.5', 500_000n],
    ['12.345678', 12_345_678n],
    ['+1.5', 1_500_000n],
  ])('converts %s USD to USDC base units', (value, expected) => {
    expect(toBaseUnits(value, 6)).toBe(expected);
  });

  it.each([
    ['more decimals than the asset has', '0.0000001'],
    ['a negative amount', '-1'],
    ['an exponent', '1e3'],
    ['a comma', '1,50'],
    ['an empty string', ''],
    ['zero', '0.00'],
  ])('rejects %s', (_label, value) => {
    expect(() => toBaseUnits(value, 6)).toThrow(RangeError);
  });
});

describe('fromBaseUnits', () => {
  it('formats base units as a decimal string', () => {
    expect(fromBaseUnits(5_000_000n, 6)).toBe('5.000000');
    expect(fromBaseUnits(1n, 6)).toBe('0.000001');
  });
});

describe('splitAmount', () => {
  const shares = [
    { role: 'rights_holder' as const, bps: 9000 },
    { role: 'operator_fee' as const, bps: 1000 },
  ];

  it('splits by basis points', () => {
    expect(splitAmount(5_000_000n, shares)).toEqual([
      { role: 'rights_holder', amount: 4_500_000n },
      { role: 'operator_fee', amount: 500_000n },
    ]);
  });

  it('gives rounding dust to the first share (the rights holder)', () => {
    expect(splitAmount(1_000_001n, shares)).toEqual([
      { role: 'rights_holder', amount: 900_001n },
      { role: 'operator_fee', amount: 100_000n },
    ]);
  });

  it('drops shares that round to zero', () => {
    expect(splitAmount(5n, shares)).toEqual([{ role: 'rights_holder', amount: 5n }]);
  });

  it('requires shares that add up to 10,000 basis points', () => {
    expect(() => splitAmount(100n, [{ role: 'rights_holder', bps: 9000 }])).toThrow(RangeError);
    expect(() => splitAmount(100n, [])).toThrow(RangeError);
  });
});
