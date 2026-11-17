import type { QueuedIssue } from "./types";
import { hasProcessingLabel } from "../../lib/issue-labels";

export interface QueueCounts {
  /** Open issues with neither the `processing` label nor a handled run. */
  pending: number;
  /** Open issues whose labels contain `processing`. */
  working: number;
}

export type QueueRowState = "running" | "handled" | "pending";

/** True when the forge listed the issue as being processed by a run. */
export function isProcessing(issue: { labels?: string[] }): boolean {
  return hasProcessingLabel(issue.labels);
}

/**
 * The one lifecycle word a queue row shows. The bridge keeps the `processing`
 * label only while a live claim owns the issue, so that label wins over the
 * ledger's handled marker; `handled` means the worker already ran the issue
 * and no live claim holds it.
 */
export function queueRowState(issue: {
  labels?: string[];
  handled?: boolean;
}): QueueRowState {
  if (isProcessing(issue)) return "running";
  return issue.handled === true ? "handled" : "pending";
}

/**
 * Splits the open queue into the states that wait for an operator. A handled
 * row is neither waiting nor working, so it leaves both counts.
 */
export function queueCounts(queue: QueuedIssue[]): QueueCounts {
  let pending = 0;
  let working = 0;
  for (const issue of queue) {
    const state = queueRowState(issue);
    if (state === "running") working += 1;
    else if (state === "pending") pending += 1;
  }
  return { pending, working };
}

/** The one-line queue total the page header and the sidebar both render. */
export function queueSummary(counts: QueueCounts): string {
  return counts.working === 0
    ? `${counts.pending} pending`
    : `${counts.pending} pending · ${counts.working} running`;
}
