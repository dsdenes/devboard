/**
 * The reads the surfaces on screen ask for, with the scope each one earns.
 *
 * One plan per render pass: the background chrome always shows the status,
 * goal draft, issue, flow, discover, goal, agent, and provider resources; the
 * active mode's body adds its own tab's resource; and the two goal-mode-only
 * resources follow the Goal mode. Nothing a closed surface, a hidden mode, or
 * a closed tab shows is claimed, so the scheduler never reads it.
 *
 * `live` is emitted only while the open body's snapshot reports a run that is
 * running or paused: an agent page whose agent runs, a run tab whose run is
 * live, and the Flow and Discover bodies while their own run is active.
 */
import { agentRegistry } from "../../lib/agent-registry.ts";
import type { AgentSnapshot } from "./types";
import { agents } from "./agents.svelte";
import { discover } from "./discover.svelte";
import { flow } from "./flow.svelte";
import { issues } from "./issues.svelte";
import { layout } from "./layout.svelte";
import type { PollScope } from "./cadence";

/** One resource one surface shows, and the scope that surface earns. */
export interface PollClaim {
  command: Record<string, unknown> & { type: string };
  scope: PollScope;
}

/** The lifecycle states a background agent reports while its page follows it. */
const LIVE_AGENT_LIFECYCLES: Readonly<Record<string, true>> = {
  running: true,
  starting: true,
  stopping: true,
};

/** The always-mounted chrome: StatusBar, ActivityBar, and the sidebar. */
export function backgroundClaims(): PollClaim[] {
  const claims: PollClaim[] = [
    { command: { type: "getVersion" }, scope: "background" },
    { command: { type: "getGoal" }, scope: "background" },
    { command: { type: "getIssues" }, scope: "background" },
    { command: { type: "getFlow" }, scope: "background" },
    { command: { type: "getDiscover" }, scope: "background" },
    { command: { type: "getGoalDrafts" }, scope: "background" },
    { command: { type: "getAgents" }, scope: "background" },
    { command: { type: "getProviders" }, scope: "background" },
  ];
  // The sidebar's record and skill rows render only on the Goal mode, and the
  // two resources cost a full corpus read each: outside that mode nothing on
  // screen shows them.
  if (layout.mode === "goal") {
    claims.push(
      { command: { type: "listRecords" }, scope: "background" },
      { command: { type: "getSkills" }, scope: "background" },
    );
  }
  return claims;
}

/** The workspace body the active mode renders, by its active tab. */
export function bodyClaims(): PollClaim[] {
  const mode = layout.mode;
  const tab = layout.activeWorkspaceTab;
  if (tab === null) return [];
  switch (mode) {
    case "goal":
      // Every Goal tab renders the goal document; the record and skill rows
      // ride the mode's own background claims at the same cadence.
      return [{ command: { type: "getGoal" }, scope: "body" }];
    case "issues":
      return issuesClaims(tab.kind, tab.resourceId);
    case "flow":
      return flowClaims();
    case "discover":
      return discoverClaims();
    case "devboard":
      return devboardClaims(tab.kind);
  }
}

/** Every claim the surfaces on screen make, in one plan. */
export function pollClaims(): PollClaim[] {
  return [...backgroundClaims(), ...bodyClaims()];
}

/** The Issues body: the worker's snapshot, the drafts list, or one run. */
function issuesClaims(kind: string, resourceId: string): PollClaim[] {
  if (kind === "drafts") return [{ command: { type: "getGoalDrafts" }, scope: "body" }];
  const claims: PollClaim[] = [{ command: { type: "getIssues" }, scope: "body" }];
  if (kind === "agent" && runLive(resourceId)) {
    claims.push({ command: { type: "getIssuesRun", runId: resourceId }, scope: "live" });
  }
  return claims;
}

function flowClaims(): PollClaim[] {
  const claims: PollClaim[] = [{ command: { type: "getFlow" }, scope: "body" }];
  if (flowLive()) claims.push({ command: { type: "getFlow" }, scope: "live" });
  return claims;
}

function discoverClaims(): PollClaim[] {
  const claims: PollClaim[] = [{ command: { type: "getDiscover" }, scope: "body" }];
  if (discoverLive()) claims.push({ command: { type: "getDiscover" }, scope: "live" });
  return claims;
}

/** The Devboard body: one page, and the one resource that page renders. */
function devboardClaims(kind: string): PollClaim[] {
  switch (kind) {
    case "mcp-tools":
      return [{ command: { type: "getMcpTools" }, scope: "body" }];
    case "devboard-resources":
      return [{ command: { type: "getResources" }, scope: "body" }];
    case "devboard-skills":
      return [{ command: { type: "getInstalledSkills" }, scope: "body" }];
    case "devboard-complexity":
      return [{ command: { type: "getComplexity" }, scope: "body" }];
    default:
      break;
  }
  if (agentRegistry.get(kind) === undefined) return [];
  const claims: PollClaim[] = [{ command: { type: "getAgents" }, scope: "body" }];
  if (agentLive(kind)) claims.push({ command: { type: "getAgents" }, scope: "live" });
  return claims;
}

/** True while this Issues run reports itself running. */
function runLive(runId: string): boolean {
  if (issues.agentFor(runId) !== null) return true;
  const run = (issues.snapshot?.runs ?? []).find((entry) => entry.runId === runId);
  return run?.status === "running";
}

/** True while the Flow body shows a run of its own. */
function flowLive(): boolean {
  return flow.status === "running" || flow.goalCreation !== null;
}

/** True while the Discover body shows a run of its own. */
function discoverLive(): boolean {
  if (discover.active || discover.starting) return true;
  if (discover.runningAll) return true;
  return (discover.state?.agents ?? []).some((agent) => agent.state === "running");
}

/** True while one background agent reports a run the page must follow. */
function agentLive(id: string): boolean {
  const snapshot: AgentSnapshot | null = agents.snapshot(id);
  if (snapshot === null) return false;
  if (snapshot.paused === true) return true;
  return LIVE_AGENT_LIFECYCLES[snapshot.lifecycle] === true;
}
