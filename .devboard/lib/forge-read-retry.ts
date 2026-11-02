/**
 * Retry policy for one background agent's periodic forge read.
 *
 * A transport failure is retried on a bounded schedule before it is shown as
 * `agent-sync-error`. A permanent failure — unusable credentials, a missing
 * repository or answer, or missing forge configuration — and a rate-limited
 * answer are surfaced on the first attempt, exactly as before. The retry
 * applies to reads only: forge writes, preflights, agent turns, and commands
 * are never retried by this module.
 */

/** Delay before each automatic retry, measured from the end of the last attempt. */
export const FORGE_READ_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1_000,
  2_000,
  4_000,
  8_000,
]);

/** The initial attempt plus one per configured delay. */
export const FORGE_READ_MAX_ATTEMPTS = FORGE_READ_RETRY_DELAYS_MS.length + 1;

export type ForgeReadFailureKind = "rate-limit" | "permanent" | "transient";

const RATE_LIMIT_PATTERNS = [
  "rate limit exceeded",
  "secondary rate limit",
  "abuse detection",
  "too many requests",
  "http 429",
  "429 too many requests",
];

/**
 * Failures another attempt cannot fix. A 401/403 that is a rate limit is
 * classified before this list, so a throttled credential stays retryable-free
 * and a genuinely unusable one surfaces at once.
 */
const PERMANENT_PATTERNS = [
  // Unusable credentials or permission.
  "bad credentials",
  "authentication failed",
  "unauthorized",
  "http 401",
  "http 403",
  "resource not accessible",
  "forbidden",
  "invalid token",
  "token is invalid",
  "permission denied",
  "write permission",
  // Missing repository, issue, or command.
  "not found",
  "http 404",
  "repository not found",
  "does not exist",
  "not a supported issue url",
  "not a github issue url",
  // A malformed answer.
  "did not print a json",
  "did not answer with json",
  "invalid json",
  "invalid response",
  "malformed",
  "unexpected response",
  "unknown issue state",
  // Missing forge configuration.
  "devboard_gitea_url",
  "no forge client",
  "missing prerequisite",
  // Other client errors an identical retry repeats.
  "http 400",
  "http 422",
];

/** Failures another attempt may fix; anything unrecognized is treated this way. */
const TRANSIENT_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "socket hang up",
  "connection reset",
  "connection refused",
  "network",
  "fetch failed",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "temporarily unavailable",
  "overloaded",
  "try again",
  "unavailable",
];

/**
 * Classifies one failed periodic read from its diagnostic. An unrecognized
 * failure is transient: the known permanent set is closed, and a transport
 * fault the forge does not name is still worth one more attempt.
 */
export function classifyForgeReadFailure(error: unknown): ForgeReadFailureKind {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (RATE_LIMIT_PATTERNS.some((pattern) => message.includes(pattern))) return "rate-limit";
  if (PERMANENT_PATTERNS.some((pattern) => message.includes(pattern))) return "permanent";
  if (TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern))) return "transient";
  return "transient";
}

/**
 * One agent's consecutive transient failures. A success resets the schedule.
 * After the fifth consecutive transient failure the budget stays exhausted, so
 * later periodic attempts follow the normal cadence and keep the alert until a
 * read succeeds instead of flapping between stale and error every interval.
 */
export class ForgeReadRetry {
  private transientFailures = 0;

  get failures(): number {
    return this.transientFailures;
  }

  get exhausted(): boolean {
    return this.transientFailures >= FORGE_READ_MAX_ATTEMPTS;
  }

  /** A successful read clears every failure and the next schedule. */
  succeed(): void {
    this.transientFailures = 0;
  }

  /**
   * Records one failure. A transient failure below the cap returns the delay
   * before the automatic retry; an exhausted, permanent, or rate-limited
   * failure returns null and resets the schedule for a later outage.
   */
  record(kind: ForgeReadFailureKind): number | null {
    if (kind !== "transient") {
      this.transientFailures = 0;
      return null;
    }
    if (this.exhausted) return null;
    const delay = FORGE_READ_RETRY_DELAYS_MS[this.transientFailures] ?? null;
    this.transientFailures += 1;
    return delay;
  }
}
