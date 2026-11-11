const BASE_MS = 30_000;
const CAP_MS = 3_600_000;

/** Delay after a failed attempt. Attempt 1 waits 30s, then the delay doubles, and it never exceeds 1 hour. */
export function retryDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) return BASE_MS;
  const doubled = BASE_MS * 2 ** (attempts - 1);
  if (!Number.isFinite(doubled)) return CAP_MS;
  return Math.min(doubled, CAP_MS);
}
