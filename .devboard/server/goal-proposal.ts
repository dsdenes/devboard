/**
 * Proposed-goal drafts for the local interface.
 *
 * The operator's report panel can turn one pick and one sentence into a raw
 * goal draft. A draft is not a goal spec: it carries the operator's text
 * verbatim plus the same captured element context an issue report carries,
 * and lives under `.devboard/goal-proposals/` until someone elaborates it with
 * `/goal-spec`. The server never files an issue, starts a conversation, or
 * writes a final goal.
 */

import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FeedbackRequestError,
  parseCapturedFields,
  parseReportText,
  type CapturedFields,
} from "./feedback";

/** Repository-relative directory holding every draft. */
export const GOAL_PROPOSALS_DIRECTORY = ".devboard/goal-proposals";

const MAX_HEADING = 200;
const MAX_NAME_WORDS = 6;
const FALLBACK_NAME = "ui-goal";
const BODY_VISIBLE_TEXT = 1500;
/** Bounds the `-2`, `-3`, … search; far past any real click count. */
const MAX_NAME_ATTEMPTS = 1000;

const DRAFT_NOTICE = "> Unprocessed draft. Refine it with `/goal-spec` before it becomes a goal.";

export interface GoalProposalSubmission extends CapturedFields {
  report: string;
}

export interface GoalProposal {
  /** Repository-relative path of the written draft, with `/` separators. */
  path: string;
}

/** Validates one proposal body: the same fields and limits as a report. */
export function parseGoalProposalSubmission(value: unknown): GoalProposalSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeedbackRequestError(400, "The proposal must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  return { report: parseReportText(source.report), ...parseCapturedFields(source) };
}

/** The report's first non-empty line, trimmed, or the empty string. */
function firstReportLine(report: string): string {
  return (
    report
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** The heading text: one line, whitespace collapsed, bounded. */
export function goalProposalHeading(report: string): string {
  const line = firstReportLine(report).replace(/\s+/g, " ");
  return line.length <= MAX_HEADING ? line : line.slice(0, MAX_HEADING);
}

/** The draft's base name: lowercase, hyphenated, at most six words. */
export function goalProposalName(report: string): string {
  const slug = firstReportLine(report)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = slug
    .split("-")
    .filter((word) => word.length > 0)
    .slice(0, MAX_NAME_WORDS)
    .join("-");
  return name.length === 0 ? FALLBACK_NAME : name;
}

function collapse(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return `${single.slice(0, limit - 1).trimEnd()}…`;
}

/** The captured context block, rendered exactly like `feedbackBody`'s. */
function capturedContext(submission: GoalProposalSubmission): string[] {
  const context: string[] = [];
  for (const [label, value] of [
    ["Route", submission.route],
    ["URL", submission.url],
    ["Selected element", submission.selector],
    ["Viewport", submission.viewport],
    ["Captured at", submission.capturedAt],
  ] as const) {
    // A backtick inside an inline code span would close it early.
    if (value.trim().length > 0) {
      context.push(`- ${label}: \`${value.trim().replace(/`/g, "'")}\``);
    }
  }

  const visible = collapse(submission.visibleText, BODY_VISIBLE_TEXT);
  if (visible.length > 0) {
    context.push("", "### Visible text", "", visible);
  }

  const dom = submission.domExcerpt.trim();
  if (dom.length > 0) {
    const fence = dom.includes("```") ? "````" : "```";
    context.push("", "### DOM excerpt", "", `${fence}html`, dom, fence);
  }

  return context.length === 0 ? ["No page context was captured."] : context;
}

/**
 * The draft body: the proposed goal, the draft notice, the operator's text
 * verbatim, then the captured context. It carries no success criteria,
 * verification, boundaries, or stop conditions; elaboration does that.
 */
export function goalProposalBody(submission: GoalProposalSubmission): string {
  return [
    `# Proposed goal: ${goalProposalHeading(submission.report)}`,
    "",
    DRAFT_NOTICE,
    "",
    submission.report,
    "",
    "## Captured UI context",
    "",
    ...capturedContext(submission),
    "",
  ].join("\n");
}

/**
 * Writes the content to `name.md`, or the first free `name-2.md`, `name-3.md`,
 * … The content is staged in a temporary file and hard-linked into place, so a
 * failed write leaves no partial draft and an existing draft is never replaced.
 */
async function createExclusive(directory: string, name: string, content: string): Promise<string> {
  const temporary = join(directory, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    for (let index = 1; index <= MAX_NAME_ATTEMPTS; index++) {
      const filename = index === 1 ? `${name}.md` : `${name}-${index}.md`;
      try {
        await link(temporary, join(directory, filename));
        return filename;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error(`No free draft filename for ${name}.md.`);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Writes one draft under `<repoDir>/.devboard/goal-proposals/`. */
export async function writeGoalProposal(
  submission: GoalProposalSubmission,
  options: { repoDir: string },
): Promise<GoalProposal> {
  const directory = join(options.repoDir, GOAL_PROPOSALS_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const filename = await createExclusive(
    directory,
    goalProposalName(submission.report),
    goalProposalBody(submission),
  );
  return { path: `${GOAL_PROPOSALS_DIRECTORY}/${filename}` };
}
