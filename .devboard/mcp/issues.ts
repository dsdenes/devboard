import type { ForgeIssueState } from "../lib/forge-issues";
import { boundBytes } from "../lib/text-budget";
import { issuesFor, type McpContext } from "./context";

/** Issue reads and the one close mutation, through the repository's forge. */

export const ISSUE_BODY_MAX_BYTES = 64 * 1024;
export const ISSUE_LIST_MAX = 200;

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
  return {
    number: issue.number,
    state: issue.state,
    url: issue.url,
  };
}
