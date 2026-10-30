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

/** The newest comment that carries a SHA yields its last SHA; else null. */
export function closingCommitFromComments(comments: string[]): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const tokens = shaTokens(comments[index] ?? "");
    if (tokens.length > 0) return tokens[tokens.length - 1]!;
  }
  return null;
}
