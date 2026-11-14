const CONTEXT_MARKER = "## Captured UI context";

/** What a captured-context section opens with when the capture held no page facts. */
const NO_CAPTURED_CONTEXT = "No page context was captured.";

/**
 * Every line the writer's captured-context section can open with: the page
 * facts, and the evidence headings both writers emit when no page fact was
 * captured.
 */
const CAPTURED_OPENINGS = [
  "- Route:",
  "- URL:",
  "- Selected element:",
  "- Viewport:",
  "- Captured at:",
  "### Visible text",
  "### DOM excerpt",
];

/** True when the section body below `from` opens with a recognized opening. */
function opensCapturedSection(lines: readonly string[], from: number): boolean {
  for (let index = from; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    if (line === NO_CAPTURED_CONTEXT) return true;
    return CAPTURED_OPENINGS.some((opening) => line.startsWith(opening));
  }
  return false;
}

/**
 * The offset where the writer's own captured-context section starts, or -1.
 * The operator's report is written verbatim above that section, so a report
 * that quotes the marker line carries candidates of its own. The writer's
 * section is the last marker at the start of a line, outside a fenced code
 * block, whose body opens with a page fact, an evidence heading, or the
 * no-context sentence.
 */
function contextSectionStart(text: string): number {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  let fence: string | null = null;
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceRun = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceRun !== undefined) {
      if (fence === null) fence = fenceRun;
      else if (fenceRun[0] === fence[0] && fenceRun.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (!line.startsWith(CONTEXT_MARKER)) continue;
    if (!opensCapturedSection(lines, index + 1)) continue;
    start = starts[index]!;
  }
  return start;
}

/**
 * Reads the proposal out of a draft. Both writers in `server/reports.ts` and
 * `server/goal-proposal.ts` put the captured evidence after a marker of their
 * own below the operator's report; the proposal keeps the writer's own text —
 * including a report line that quotes the marker — and drops a leading H1,
 * which the detail header renders as the draft's title. A heading that is not
 * that leading H1 stays in the text.
 */
export function draftProposal(text: string): string {
  const index = contextSectionStart(text);
  const before = index === -1 ? text : text.slice(0, index);
  return before.trim().replace(/^#\s+[^\n]*/, "").trim();
}
