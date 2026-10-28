const CONTEXT_MARKER = "## Captured UI context";

/**
 * Reads the proposal out of a draft. Both writers in `server/feedback.ts` and
 * `server/goal-proposal.ts` put the captured evidence after this one marker;
 * the proposal keeps the writer's own text and loses the heading the panel
 * already shows.
 */
export function draftProposal(text: string): string {
  const index = text.indexOf(CONTEXT_MARKER);
  const before = index === -1 ? text : text.slice(0, index);
  return before.trim().replace(/^#\s+[^\n]*/, "").trim();
}
