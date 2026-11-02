/**
 * One title identity. Lowercase, whitespace collapsed, trimmed: the form every
 * duplicate comparison uses, so "Fix  Parser" and "fix parser" are one title.
 */
export function normalizeIssueTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}
