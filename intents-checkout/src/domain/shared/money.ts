const BASE_UNITS = /^[1-9][0-9]{0,77}$/u;

/** A positive amount in base units: digits only, no leading zero, at most 78 digits (numeric(78,0)). */
export function isPositiveBaseUnits(value: string): boolean {
  return BASE_UNITS.test(value);
}
