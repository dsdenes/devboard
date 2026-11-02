import type { BadgeTone } from "./record-status";

/**
 * The one run-state vocabulary every sidebar entry that can start, or is
 * produced by, an agent carries in `data-run-state`. `idle` renders no badge;
 * the other three render a visible badge with their own word.
 */
export type RunState = "idle" | "running" | "failed" | "answer";

/** The badge tone a run state earns: running is accent, failed error, answer warning. */
export function runStateTone(state: RunState): BadgeTone | undefined {
  switch (state) {
    case "running":
      return "accent";
    case "failed":
      return "error";
    case "answer":
      return "warning";
    default:
      return undefined;
  }
}

/** One Discover agent's own entry state; a pending question means the run waits. */
export function discoverAgentRunState(
  status: string | null,
  hasQuestion: boolean,
): RunState {
  if (status === "running" && hasQuestion) return "answer";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "idle";
}

/**
 * The seven-agent Run all suite's own entry state. The Overview entry is the
 * only entry sourced by the suite: starting one agent never marks it.
 */
export function discoverSuiteRunState(
  runningAll: boolean,
  failed: boolean,
  hasQuestion: boolean,
): RunState {
  if (runningAll && hasQuestion) return "answer";
  if (runningAll) return "running";
  if (failed) return "failed";
  return "idle";
}

/** A background agent entry follows its lifecycle; a pending question wins. */
export function agentLifecycleRunState(lifecycle: string, hasQuestion: boolean): RunState {
  if (hasQuestion) return "answer";
  switch (lifecycle) {
    case "running":
    case "starting":
      return "running";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}
