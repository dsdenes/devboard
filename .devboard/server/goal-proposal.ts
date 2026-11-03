/**
 * Proposed-goal drafts for the local interface.
 *
 * The operator's report panel can turn one pick and one sentence into a raw
 * goal draft. A draft is not a goal spec: it carries the operator's text
 * verbatim, the Ask conversation when the panel has one, plus the same
 * captured element context an issue report carries,
 * and lives under `.devboard/goal-proposals/` until someone elaborates it with
 * `/goal-spec`. The server never files an issue, starts a conversation, or
 * writes a final goal.
 */

import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GOAL_PROPOSALS_DIRECTORY } from "../lib/goal-proposals";
import {
  FeedbackRequestError,
  GOAL_PROPOSAL_BODY_KEYS,
  conversationSection,
  parseCapturedFields,
  parseReportText,
  parseTurns,
  rejectUnknownFields,
  type CapturedFields,
  type FeedbackTurn,
} from "./feedback";

const MAX_HEADING = 200;
const MAX_NAME_WORDS = 6;
/** The bounds a draft's base name must respect, whether chosen or derived. */
const MAX_SLUG_WORDS = MAX_NAME_WORDS;
const MAX_SLUG_LENGTH = 64;
const FALLBACK_NAME = "ui-goal";
const BODY_VISIBLE_TEXT = 1500;
/** The context-free draft's one-line statement of what it is. */
const UNPROCESSED_NOTICE = "> Unprocessed draft. Elaborate it to turn it into a goal.";
const NO_CAPTURED_CONTEXT = "No page context was captured.";
/** Bounds the `-2`, `-3`, … search; far past any real click count. */
const MAX_NAME_ATTEMPTS = 1000;

export interface GoalProposalSubmission extends CapturedFields {
  report: string;
  /** The visible Ask turns the operator had about this element, if any. */
  turns: FeedbackTurn[];
}

export interface GoalProposal {
  /** The common hypertext control object: a link to the written draft. */
  links: {
    draft: {
      href: string;
    };
  };
}

/** Validates one proposal body, refusing any key the endpoint does not accept. */
export function parseGoalProposalSubmission(value: unknown): GoalProposalSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeedbackRequestError(400, "The proposal must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  rejectUnknownFields(source, GOAL_PROPOSAL_BODY_KEYS);
  return {
    report: parseReportText(source.report),
    turns: parseTurns(source.turns),
    ...parseCapturedFields(source),
  };
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

/**
 * The draft's deterministic fallback name: lowercase, hyphenated, at most six
 * words and `MAX_SLUG_LENGTH` characters, so it is always usable as a file name.
 */
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
  if (name.length === 0) return FALLBACK_NAME;
  if (name.length <= MAX_SLUG_LENGTH) return name;
  return name.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates one naming agent's answer. Every non-fence line is considered with
 * surrounding backticks and quotes, an optional `slug:` label, a leading list
 * marker, and trailing punctuation removed; the last line that is a complete
 * lowercase kebab-case slug within the word and length bounds wins, so short
 * framing like "Here is the slug:" does not discard a good answer. Returns
 * `null` when no line qualifies, so a malformed answer falls back to the
 * deterministic name instead of producing an unusable file name.
 */
export function normalizeGoalSlug(value: string): string | null {
  let slug: string | null = null;
  for (const line of value.split("\n")) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("```")) continue;
    const candidate = entry
      .replace(/^[-*]\s+/, "")
      .replace(/^[`'"*_~]+/, "")
      .replace(/[`'"*_~.,;:!?]+$/, "")
      .replace(/^slug\s*[:=]\s*/i, "")
      .trim()
      .toLowerCase();
    if (!SLUG_PATTERN.test(candidate)) continue;
    if (candidate.length > MAX_SLUG_LENGTH) continue;
    if (candidate.split("-").length > MAX_SLUG_WORDS) continue;
    slug = candidate;
  }
  return slug;
}

/** Resolves the draft's base name from a naming agent, with a deterministic fallback. */
async function chooseGoalName(
  report: string,
  slugger: ((report: string) => Promise<string>) | undefined,
): Promise<string> {
  if (slugger === undefined) return goalProposalName(report);
  const suggestion = await slugger(report).catch(() => undefined);
  return (suggestion === undefined ? null : normalizeGoalSlug(suggestion)) ?? goalProposalName(report);
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

  return context.length === 0 ? [NO_CAPTURED_CONTEXT] : context;
}

/**
 * The draft body: the proposed goal, the operator's text verbatim, the Ask
 * conversation, then the captured context. It carries no notice line, success
 * criteria, verification, boundaries, or stop conditions; elaboration does
 * that.
 */
export function goalProposalBody(submission: GoalProposalSubmission): string {
  const askTurns = conversationSection(submission.turns);
  const context = capturedContext(submission);
  // A draft typed straight into the Draft goals page carries no captured
  // element. Only that context-free body states what it is; a proposal with
  // captured context keeps the report panel's existing body exactly.
  const notice = context.length === 1 && context[0] === NO_CAPTURED_CONTEXT;
  return [
    `# Proposed goal: ${goalProposalHeading(submission.report)}`,
    "",
    ...(notice ? [UNPROCESSED_NOTICE, ""] : []),
    submission.report,
    "",
    ...(askTurns.length === 0 ? [] : [...askTurns, ""]),
    "## Captured UI context",
    "",
    ...context,
    "",
  ].join("\n");
}

/**
 * Writes the content to `name.md`, or the first free `name-2.md`, `name-3.md`,
 * … The content is staged in a temporary file and hard-linked into place, so a
 * failed write leaves no partial draft and an existing draft is never replaced.
 */
export async function createExclusive(directory: string, name: string, content: string): Promise<string> {
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
  options: { repoDir: string; slugger?: (report: string) => Promise<string> },
): Promise<GoalProposal> {
  const directory = join(options.repoDir, GOAL_PROPOSALS_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const filename = await createExclusive(
    directory,
    await chooseGoalName(submission.report, options.slugger),
    goalProposalBody(submission),
  );
  return { links: { draft: { href: pathToFileURL(join(directory, filename)).href } } };
}
