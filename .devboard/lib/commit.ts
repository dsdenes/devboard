/**
 * Commit text helpers shared by the forge readers. They are pure string
 * functions with no import of their own, so the host prefix can load them
 * without the checkout and Git plumbing the release resolver uses.
 */

const SHA = /^[0-9a-fA-F]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_TOKEN = /\b[0-9a-fA-F]{7,40}\b/g;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && FULL_SHA.test(value);
}

/** Every 7–40 character hex token in a comment, in the order it appears. */
export function shaTokens(text: string): string[] {
  return [...text.matchAll(SHA_TOKEN)].map((match) => match[0]);
}

/** The most candidates one issue may resolve, so a verbose thread stays bounded. */
export const COMMIT_CANDIDATE_LIMIT = 12;

/**
 * The commit candidates a comment set names, newest comment first and last
 * token first inside one comment. Comment prose carries fingerprints, process
 * ids, and epoch stamps that look like a SHA, so every token is a candidate
 * the reader verifies rather than the one commit it trusts. The bound keeps a
 * verbose thread from turning one issue into an unbounded forge read.
 */
export function commitCandidatesFromComments(
  comments: string[],
  limit = COMMIT_CANDIDATE_LIMIT,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const tokens = shaTokens(comments[index] ?? "");
    for (let token = tokens.length - 1; token >= 0; token -= 1) {
      const value = tokens[token]!;
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push(value);
      if (candidates.length >= limit) return candidates;
    }
  }
  return candidates;
}

/** The newest comment that carries a SHA yields its last SHA; else null. */
export function closingCommitFromComments(comments: string[]): string | null {
  return commitCandidatesFromComments(comments, 1)[0] ?? null;
}
