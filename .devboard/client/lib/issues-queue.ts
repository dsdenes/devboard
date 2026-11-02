import type { QueuedIssue } from "./types";
import { hasProcessingLabel, PROCESSING_LABEL } from "../../lib/issue-labels";

export { PROCESSING_LABEL };

export interface QueueCounts {
  /** Open issues whose labels do not contain `processing`. */
  pending: number;
  /** Open issues whose labels contain `processing`. */
  working: number;
}

/** True when the forge listed the issue as being processed by a run. */
export function isProcessing(issue: { labels?: string[] }): boolean {
  return hasProcessingLabel(issue.labels);
}

/** Splits the open queue into the states a row can show. */
export function queueCounts(queue: QueuedIssue[]): QueueCounts {
  let pending = 0;
  let working = 0;
  for (const issue of queue) {
    if (isProcessing(issue)) working += 1;
    else pending += 1;
  }
  return { pending, working };
}

/** The one-line queue total the page header and the sidebar both render. */
export function queueSummary(counts: QueueCounts): string {
  return counts.working === 0
    ? `${counts.pending} pending`
    : `${counts.pending} pending · ${counts.working} running`;
}
