import type { IssuesLifecycle } from "./types";

/**
 * The issues status bar and the Automation panel subtitle are derived here so
 * the runtime gate reads the same text the page renders. A known harness
 * version is never hidden behind a tooltip and never reads `unknown`.
 */
export function versionLabel(version: string | null | undefined): string {
  return version === null || version === undefined || version.length === 0
    ? "unknown"
    : version;
}

/**
 * The status bar's issues indicator. `running` is the family's running work,
 * so a newer worker keeps the label on `working` while an older member drains.
 * An operator's Pause remains `pausing`.
 */
export function issuesLabel(
  lifecycle: IssuesLifecycle,
  runningAgents: number,
  pending = 0,
): string {
  if (lifecycle === "running") return `issues working (${runningAgents})`;
  if (lifecycle === "pausing") return "issues pausing";
  if (lifecycle === "paused") return "issues paused";
  if (lifecycle === "failed") return "issues failed";
  if (lifecycle === "idle") return pending > 0 ? `issues idle (${pending})` : "issues idle";
  return "issues stopped";
}

export interface IssuesIndicatorInput {
  repo: string | null;
  lifecycle: IssuesLifecycle;
  /** Running agents across every attached worker. */
  agents: number;
  workerPid: number | null;
  lastError: string | null;
}

/** The indicator's tooltip: the family state, never one member's shutdown. */
export function issuesIndicatorTitle(input: IssuesIndicatorInput): string {
  const repo = input.repo ?? "this checkout";
  const detail =
    input.lifecycle === "failed" && input.lastError !== null
      ? ` · ${input.lastError}`
      : input.workerPid === null
        ? ""
        : ` · worker pid ${input.workerPid}`;
  return `Issues automation for ${repo} · ${input.lifecycle} · ${input.agents} running agent(s)${detail}`;
}
