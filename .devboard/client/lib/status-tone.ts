import type { BadgeTone } from "./record-status";

/**
 * The tone one process status earns, wherever the dashboard renders it.
 *
 * A status word has one color in every surface: active work is `accent`,
 * successful completion is `success`, a failure is `error`, and anything that
 * is neither working nor finished — stopped, paused, parked, idle, closed,
 * unknown — stays neutral. Stopped work therefore never borrows the running
 * color, and a status that changes surface does not change meaning.
 */
export function statusTone(status: string): BadgeTone | undefined {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "scanning":
    case "pausing":
    case "retrying":
      return "accent";
    case "succeeded":
    case "merged":
    case "handled":
    case "accepted":
      return "success";
    case "failed":
      return "error";
    case "pending":
      return "pending";
    case "stale":
      return "stale";
    default:
      return undefined;
  }
}
