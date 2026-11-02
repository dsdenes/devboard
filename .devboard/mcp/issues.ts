import { FORGE_ISSUE_LIST_MAX, type ForgeIssueState } from "../lib/forge-issues";
import { boundBytes } from "../lib/text-budget";
import { normalizeIssueTitle } from "../lib/issue-title";
import { readDraftGoalHeadings } from "../lib/draft-goals";
import { DEAD_CODE_LABEL } from "../issues/dead-code/paths";
import { recordClosedByRun } from "../issues/self-close";
import { issuesFor, type McpContext } from "./context";

/** Issue reads and the write mutations, through the repository's forge. */

export const ISSUE_BODY_MAX_BYTES = 64 * 1024;
/**
 * The rows one `issues_list` call reports. It sits one row below the forge's
 * own ceiling so the `limit + 1` probe that decides `truncated` still reaches
 * the forge instead of being clamped back to a full page.
 */
export const ISSUE_LIST_MAX = FORGE_ISSUE_LIST_MAX - 1;

export interface IssueRow {
  number: number;
  title: string;
  state: ForgeIssueState;
  labels: string[];
  url: string;
  createdAt: string | null;
}

function boundedBody(body: string): { body: string; truncated: boolean } {
  const bounded = boundBytes(body, ISSUE_BODY_MAX_BYTES);
  return { body: bounded.text, truncated: bounded.truncated };
}

export async function listIssues(
  context: McpContext,
  options: { state?: unknown; limit?: unknown },
): Promise<{ issues: IssueRow[]; truncated: boolean }> {
  const state =
    options.state === undefined
      ? "all"
      : options.state === "open" || options.state === "closed" || options.state === "all"
        ? options.state
        : undefined;
  if (state === undefined) throw new Error('state must be "open", "closed", or "all".');
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit)
      ? Math.max(1, Math.min(ISSUE_LIST_MAX, options.limit))
      : ISSUE_LIST_MAX;
  const forge = issuesFor(context);
  const issues = await forge.list(state, limit + 1);
  return { issues: issues.slice(0, limit), truncated: issues.length > limit };
}

export async function getIssue(context: McpContext, number: unknown) {
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new Error("number must be a positive issue number.");
  }
  const forge = issuesFor(context);
  const issue = await forge.get(number);
  const body = boundedBody(issue.body);
  return { ...issue, body: body.body, truncated: body.truncated };
}

export async function closeIssue(
  context: McpContext,
  options: { number?: unknown; reason?: unknown },
) {
  if (typeof options.number !== "number" || !Number.isInteger(options.number) || options.number <= 0) {
    throw new Error("number must be a positive issue number.");
  }
  const reason = options.reason === undefined ? "completed" : options.reason;
  if (reason !== "completed" && reason !== "not planned") {
    throw new Error('reason must be "completed" or "not planned".');
  }
  const forge = issuesFor(context);
  const issue = await forge.close(options.number, reason);
  // An issues run closes its own issue as its last step; naming the run keeps
  // that close from reading as an operator's cancellation.
  const runId = context.environment.DEVBOARD_ISSUES_RUN_ID;
  if (typeof runId === "string" && runId.length > 0) {
    try {
      recordClosedByRun(context.stateDir, context.repoDir, issue.number, runId);
    } catch {
      // The close already landed; without the record a poll classifies it as
      // before and may stop the run.
    }
  }
  return {
    number: issue.number,
    state: issue.state,
    url: issue.url,
  };
}

const ISSUE_TITLE_MAX_BYTES = 255;

function issueTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("A one-line issue title is required.");
  }
  const title = value.trim();
  if (/[\r\n]/.test(title)) throw new Error("The issue title must be one line.");
  if (Buffer.byteLength(title, "utf8") > ISSUE_TITLE_MAX_BYTES) {
    throw new Error(`The issue title must be at most ${ISSUE_TITLE_MAX_BYTES} bytes.`);
  }
  return title;
}

function issueLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("labels must be a list of label names.");
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("labels must be a list of non-empty label names.");
    }
    const label = entry.trim();
    if (label.length > 100) throw new Error("A label name is longer than 100 characters.");
    labels.push(label);
  }
  return [...new Set(labels)];
}

/**
 * Creates one issue with a full Markdown body and the requested labels. Each
 * label is ensured first, so a label deleted while an agent runs still lands on
 * the created issue. The returned identity is the created issue, not an echo.
 */
export async function createIssue(
  context: McpContext,
  options: { title?: unknown; body?: unknown; labels?: unknown },
) {
  const title = issueTitle(options.title);
  if (typeof options.body !== "string" || options.body.trim().length === 0) {
    throw new Error("A non-empty Markdown body is required.");
  }
  if (Buffer.byteLength(options.body, "utf8") > ISSUE_BODY_MAX_BYTES) {
    throw new Error(`The issue body must be at most ${ISSUE_BODY_MAX_BYTES} bytes.`);
  }
  const labels = issueLabels(options.labels);
  const forge = issuesFor(context);
  // A dead-code finding is a claim about absence, so an already known title is
  // never filed again: the guard covers every dead-code issue in any state,
  // every open issue, and every draft-goal heading. It reads the forge page by
  // page instead of the newest `issues_list` window, because a closed finding
  // older than that window is exactly the duplicate this guard exists for.
  if (labels.includes(DEAD_CODE_LABEL)) {
    if ([...title].length > 200) {
      throw new Error("A dead-code title must be at most 200 characters.");
    }
    const known = new Set<string>();
    for (const issue of await forge.listAll("all")) {
      if (issue.state === "open" || issue.labels.includes(DEAD_CODE_LABEL)) {
        known.add(normalizeIssueTitle(issue.title));
      }
    }
    for (const heading of readDraftGoalHeadings(context.repoDir)) {
      known.add(normalizeIssueTitle(heading));
    }
    if (known.has(normalizeIssueTitle(title))) {
      throw new Error(
        `A dead-code finding titled "${title}" already exists; nothing was filed. ` +
          `The guard compared ${known.size} issue titles.`,
      );
    }
  }
  for (const label of labels) await forge.ensureLabel(label);
  const issue = await forge.create({ title, body: options.body, labels });
  return {
    number: issue.number,
    url: issue.url,
    title: issue.title,
    labels: issue.labels,
  };
}

/** Comments on one issue and confirms the target that received it. */
export async function commentIssue(
  context: McpContext,
  options: { number?: unknown; body?: unknown },
) {
  if (typeof options.number !== "number" || !Number.isInteger(options.number) || options.number <= 0) {
    throw new Error("number must be a positive issue number.");
  }
  if (typeof options.body !== "string" || options.body.trim().length === 0) {
    throw new Error("A non-empty comment body is required.");
  }
  if (Buffer.byteLength(options.body, "utf8") > ISSUE_BODY_MAX_BYTES) {
    throw new Error(`The comment body must be at most ${ISSUE_BODY_MAX_BYTES} bytes.`);
  }
  const forge = issuesFor(context);
  await forge.comment(options.number, options.body);
  return { number: options.number, commented: true };
}
