const BASE_UNITS = /^[1-9][0-9]{0,77}$/u;

/** A positive amount in base units: digits only, no leading zero, at most 78 digits (numeric(78,0)). */
export function isPositiveBaseUnits(value: string): boolean {
  return BASE_UNITS.test(value);
}

/** `left - right`, floored at zero. Both strings are base units. This does not use floating point. */
export function subtractBaseUnits(left: string, right: string): string {
  const difference = BigInt(left) - BigInt(right);
  return difference > 0n ? difference.toString() : '0';
}

/** True when `left` is greater than `right`. Both strings are base units. */
export function exceedsBaseUnits(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}
