import { resolve } from "node:path";
import { pidAlive } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import { ScoutBridge } from "../server/scout";
import { agentRegistry, projectAgentSnapshot, type AgentSnapshot } from "../server/agents/registry";
import { readWatchdogStatus } from "../watchdog/status";
import { readWatchdogSettings } from "../watchdog/settings";
import { readWorkerState as readWatchdogWorker, type WatchdogWorkerState } from "../watchdog/worker-state";
import { readProjection } from "../watchdog/projection";
import { watchdogDirectory } from "../watchdog/paths";
import { readCoachStatus } from "../coach/status";
import { readCoachSettings } from "../coach/settings";
import { coachDirectory } from "../coach/paths";
import { readWorkerState as readCoachWorker, type CoachWorkerState } from "../coach/worker-state";
import type { AgentSnapshotInput } from "../server/agents/registry";
import type { McpContext } from "./context";
import { dashboardCommand, dashboardsFor, type LiveDashboard } from "./dashboard";

/**
 * The background-agent snapshot a read tool returns. With one live dashboard
 * it is exactly what `getAgents`/`getAgent` answer; otherwise it is projected
 * from the persisted worker, settings, ledger, and projection files.
 */

function live(context: McpContext): LiveDashboard | undefined {
  const found = dashboardsFor(context);
  return found.length === 1 ? found[0] : undefined;
}

async function liveAgents(context: McpContext): Promise<AgentSnapshot[] | undefined> {
  const dashboard = live(context);
  if (dashboard === undefined) return undefined;
  const reply = await dashboardCommand(
    dashboard,
    { type: "getAgents" },
    (candidate) => candidate.type === "agentsState",
  );
  const agents = reply.agents;
  return Array.isArray(agents) ? (agents as AgentSnapshot[]) : undefined;
}

function workerLifecycle(
  worker: WatchdogWorkerState | CoachWorkerState | undefined,
  attached: boolean,
): AgentSnapshotInput["lifecycle"] {
  if (attached) return worker?.lifecycle === "failed" ? "failed" : "running";
  return worker?.lifecycle === "failed" ? "failed" : "stopped";
}

function scoutSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("scout");
  const bridge = new ScoutBridge({
    descriptor,
    repoDir: context.repoDir,
    stateDir: context.stateDir,
    agentCommand: context.environment.AGENT_COMMAND ?? "omp acp",
    agentEnvironment: async () => context.environment,
    runningVersion: readHarnessVersion(context.harnessDir),
    harnessDir: context.harnessDir,
    send: () => undefined,
    environment: context.environment,
  });
  return projectAgentSnapshot(descriptor, bridge.snapshot());
}

function watchdogSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("watchdog");
  const directory = watchdogDirectory(context.repoDir);
  const worker = readWatchdogWorker(directory);
  const attached =
    worker !== undefined && worker.lifecycle !== "stopped" && pidAlive(worker.pid);
  const owned = attached && resolve(worker?.stateDir ?? "") === resolve(context.stateDir);
  const status = readWatchdogStatus(directory);
  const settings = readWatchdogSettings(directory);
  const projection = readProjection(directory);
  const facts = new Map(
    (projection?.issues ?? []).map((issue) => [issue.url, issue.state] as const),
  );
  const lifecycle = workerLifecycle(worker, attached);
  return projectAgentSnapshot(descriptor, {
    lifecycle,
    enabled: attached && worker?.enabled === true && lifecycle !== "stopped",
    owned,
    attached,
    cadence: {
      minutes: settings.intervalMinutes,
      lastRunAt: worker?.lastRunAt ?? status.cycle,
      nextRunAt: attached ? (worker?.nextRunAt ?? null) : null,
    },
    limits: {
      maxPerHour: settings.maxPerHour,
      maxPending: settings.maxPending,
    },
    issues: status.issues.map((issue) => ({
      title: `[watchdog] ${issue.category}: ${issue.line}`,
      category: issue.category,
      filedAt: issue.filedAt,
      url: issue.url,
      state: facts.get(issue.url) === "implemented" ? "implemented" : facts.get(issue.url) === "pending" ? "pending" : "unknown",
      version: null,
    })),
    pending: status.pending,
    sync:
      projection === undefined
        ? { state: "stale", at: null, error: null }
        : { state: projection.state, at: projection.at, error: projection.error },
    detail: { panel: "cycles", cycles: status.cycles },
    notice: worker?.notice ?? null,
    error: worker?.lastError ?? null,
    timer: null,
  });
}

function coachSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("coach");
  const directory = coachDirectory(context.stateDir);
  const worker = readCoachWorker(directory);
  const attached =
    worker !== undefined && worker.lifecycle !== "stopped" && pidAlive(worker.pid);
  const owned = attached && resolve(worker?.stateDir ?? "") === resolve(context.stateDir);
  const status = readCoachStatus(directory);
  const settings = readCoachSettings(directory);
  const projection = readProjection(directory);
  const facts = new Map(
    (projection?.issues ?? []).map((issue) => [issue.url, issue] as const),
  );
  const lifecycle = workerLifecycle(worker, attached);
  return projectAgentSnapshot(descriptor, {
    lifecycle,
    enabled: attached && worker?.enabled === true && lifecycle !== "stopped",
    owned,
    attached,
    cadence: {
      minutes: settings.intervalMinutes,
      lastRunAt: worker?.lastRunAt ?? status.cycle,
      nextRunAt: attached ? (worker?.nextRunAt ?? null) : null,
    },
    limits: {
      maxPerHour: settings.maxPerHour,
      maxPending: settings.maxPending,
    },
    issues: status.issues.map((issue) => ({
      title: `[coach] ${issue.category}: ${issue.line}`,
      category: issue.category,
      filedAt: issue.filedAt,
      url: issue.url,
      state:
        facts.get(issue.url)?.state === "implemented"
          ? "implemented"
          : facts.get(issue.url)?.state === "pending"
            ? "pending"
            : "unknown",
      version:
        facts.get(issue.url)?.state === "implemented"
          ? (facts.get(issue.url)?.version ?? null)
          : null,
    })),
    pending: status.pending,
    sync:
      projection === undefined
        ? { state: "stale", at: null, error: null }
        : { state: projection.state, at: projection.at, error: projection.error },
    detail: { panel: "cycles", cycles: status.cycles },
    notice: worker?.notice ?? null,
    error: worker?.lastError ?? null,
    timer: null,
  });
}

function persistedAgents(context: McpContext): AgentSnapshot[] {
  return agentRegistry.descriptors.map((descriptor) => {
    if (descriptor.id === "scout") return scoutSnapshot(context);
    if (descriptor.id === "watchdog") return watchdogSnapshot(context);
    return coachSnapshot(context);
  });
}

export async function backgroundAgentsList(context: McpContext): Promise<AgentSnapshot[]> {
  return (await liveAgents(context)) ?? persistedAgents(context);
}

export async function backgroundAgentGet(
  context: McpContext,
  id: string,
): Promise<AgentSnapshot | undefined> {
  if (agentRegistry.get(id) === undefined) return undefined;
  const dashboard = live(context);
  if (dashboard !== undefined) {
    const reply = await dashboardCommand(
      dashboard,
      { type: "getAgent", id },
      (candidate) =>
        candidate.type === "agentState" &&
        typeof candidate.agent === "object" &&
        candidate.agent !== null &&
        "id" in candidate.agent &&
        candidate.agent.id === id,
    );
    return reply.agent as AgentSnapshot;
  }
  return persistedAgents(context).find((agent) => agent.id === id);
}
