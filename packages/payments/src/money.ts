/** Exact decimal ↔ base-unit conversion and basis-point splits, with bigint arithmetic only. */

export type PayeeRole = 'rights_holder' | 'operator_fee';

/** Converts a positive decimal string (as in RSL `<amount>`) to base units of an asset. */
export function toBaseUnits(value: string, decimals: number): bigint {
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(value);
  const whole = match?.[1] ?? '';
  const fraction = match?.[2] ?? '';
  if (!match || (whole === '' && fraction === '')) throw new RangeError(`not a decimal amount: "${value}"`);
  if (fraction.length > decimals) throw new RangeError(`"${value}" has more than ${decimals} decimal places`);
  const units = BigInt((whole || '0') + fraction.padEnd(decimals, '0'));
  if (units <= 0n) throw new RangeError(`amount must be positive, found "${value}"`);
  return units;
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  const text = units.toString().padStart(decimals + 1, '0');
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}

/**
 * Splits `total` by basis points. Every share after the first is rounded down, and the first
 * (the rights holder) receives the rest, so rounding never favours the operator. Shares that
 * come to zero are dropped, because a zero transfer is pointless.
 */
export function splitAmount(
  total: bigint,
  shares: readonly { role: PayeeRole; bps: number }[],
): { role: PayeeRole; amount: bigint }[] {
  const sum = shares.reduce((acc, share) => acc + share.bps, 0);
  if (shares.length === 0 || sum !== 10_000 || shares.some((s) => !Number.isInteger(s.bps) || s.bps < 0)) {
    throw new RangeError('shares must be whole basis points that add up to 10,000');
  }
  const rest = shares.slice(1).map((share) => ({ role: share.role, amount: (total * BigInt(share.bps)) / 10_000n }));
  const first = { role: shares[0]!.role, amount: total - rest.reduce((acc, share) => acc + share.amount, 0n) };
  return [first, ...rest].filter((share) => share.amount > 0n);
}
