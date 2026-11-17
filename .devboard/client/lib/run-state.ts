import type { BadgeTone } from "./record-status";

/**
 * The one run-state vocabulary every sidebar entry that can start, or is
 * produced by, an agent carries in `data-run-state`. `idle` renders no badge;
 * the other three render a visible badge with their own word.
 */
export type RunState = "idle" | "running" | "failed" | "answer";

/**
 * A mode rail dot's state. `stale` is the rail's own degraded word; every other
 * value is a `RunState`, so the rail and the sidebar read the same precedence.
 */
export type ModeState = "running" | "attention" | "idle" | "stale" | null;

/** A run state as the rail shows it: a wait and a failure both need the operator. */
export function modeStateOf(state: RunState): ModeState {
  switch (state) {
    case "running":
      return "running";
    case "answer":
    case "failed":
      return "attention";
    default:
      return "idle";
  }
}

/**
 * The Issues family's state, shared by the mode rail and its sidebar entry: a
 * waiting question outranks the live lifecycle, whose own failure ranks below.
 */
export function issuesRunState(lifecycle: string, hasQuestion: boolean): RunState {
  if (hasQuestion) return "answer";
  if (lifecycle === "running" || lifecycle === "pausing") return "running";
  if (lifecycle === "failed") return "failed";
  return "idle";
}

/** The Flow session's state, shared by the mode rail and its sidebar entry. */
export function flowRunState(status: string, hasQuestion: boolean): RunState {
  if (hasQuestion) return "answer";
  return status === "running" ? "running" : "idle";
}

/**
 * The Discover rail's dot: any agent's pending question outranks the live run,
 * and a failed agent or stale artifacts need the operator before the mode
 * reports idle. `busy` is a transient change the operator started.
 */
export function discoverModeState(facts: {
  active: boolean;
  stale: boolean;
  busy: boolean;
  hasQuestion: boolean;
  hasFailedAgent: boolean;
}): ModeState {
  if (facts.hasQuestion) return "attention";
  if (facts.active) return "running";
  if (facts.hasFailedAgent) return "attention";
  if (facts.stale) return "stale";
  if (facts.busy) return "attention";
  return null;
}

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
