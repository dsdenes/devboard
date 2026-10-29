/**
 * A wall-clock bound for work that must never leave a caller waiting. The
 * raced promise keeps running (or stalls) in the background; the caller only
 * regains control at the deadline and can retry.
 */

export const DEADLINE_EXPIRED: unique symbol = Symbol("deadline-expired");

export async function withinDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof DEADLINE_EXPIRED> {
  const expired = Promise.withResolvers<typeof DEADLINE_EXPIRED>();
  const timer = setTimeout(() => expired.resolve(DEADLINE_EXPIRED), Math.max(1, timeoutMs));
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}
