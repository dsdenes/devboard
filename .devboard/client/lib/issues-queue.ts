import type { QueuedIssue } from "./types";

export interface QueueCounts {
  /** Open issues no run has reached yet: the queue's waiting work. */
  pending: number;
  /** Open issues an agent is working right now. */
  working: number;
}

/**
 * Splits the open queue into the states a row can show. Handled wins over a
 * stale run id, exactly as the row's own badge does, so the totals never
 * disagree with the rows they sum.
 */
export function queueCounts(queue: QueuedIssue[]): QueueCounts {
  let pending = 0;
  let working = 0;
  for (const issue of queue) {
    if (issue.handled) continue;
    if (issue.agentRunId !== null) working += 1;
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
