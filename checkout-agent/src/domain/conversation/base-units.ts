/** A base-unit amount is a decimal string of digits. Floats are not amounts. */
export function isBaseUnits(value: string): boolean {
  return /^[0-9]+$/u.test(value);
}
