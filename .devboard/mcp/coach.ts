import { appendToolLog } from "./tool-log";
import type { McpContext } from "./context";

/**
 * The Coach synthesis turn files its own issue through `issue_create` and
 * records why a family filed nothing through this tool. The coordinator reads
 * that record as the family's skipped reason; no answer document is involved.
 */

export const COACH_SKIP_LOG = "DEVBOARD_COACH_SKIP_LOG";

export function recordCoachSkip(
  context: McpContext,
  options: { family?: unknown; reason?: unknown },
) {
  const family = options.family;
  if (typeof family !== "string" || family.trim().length === 0) {
    throw new Error("family must be a non-empty family key.");
  }
  const reason = options.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("reason must state why this family filed nothing.");
  }
  const value = {
    family: family.trim(),
    status: "skipped",
    reason: reason.trim(),
  };
  appendToolLog(
    context,
    { tool: "coach_proposal_skip", at: new Date().toISOString(), ok: true, value },
    COACH_SKIP_LOG,
  );
  return value;
}
