import { resolve } from "node:path";
import { pidAlive } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import { ScoutBridge } from "../server/scout";
import { DesignBridge } from "../server/design";
import { ApiStandardsBridge } from "../server/api-standards";
import { DeadCodeBridge } from "../server/dead-code";
import { SingleResponsibilityBridge } from "../server/single-responsibility";
import { agentRegistry, projectAgentSnapshot, type AgentSnapshot } from "../server/agents/registry";
import { readWatchdogStatus } from "../watchdog/status";
import { readWatchdogSettings } from "../watchdog/settings";
import { readWorkerState as readWatchdogWorker, type WatchdogWorkerState } from "../watchdog/worker-state";
import { readProjection } from "../watchdog/projection";
import { watchdogDirectory } from "../watchdog/paths";
import { readMcpOptimizerStatus } from "../mcp-optimizer/status";
import { readMcpOptimizerSettings } from "../mcp-optimizer/settings";
import { mcpOptimizerDirectory } from "../mcp-optimizer/paths";
import { readWorkerState as readMcpOptimizerWorker, type McpOptimizerWorkerState } from "../mcp-optimizer/worker-state";
import { releaseTrainDirectory } from "../release-train/paths";
import { readSettings as readReleaseTrainSettings } from "../release-train/settings";
import {
  readState as readReleaseTrainState,
  type ReleaseTrainWorkerRecord,
} from "../release-train/state";
import { releaseTrainWorkerStates } from "../release-train/worker";
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
  worker: WatchdogWorkerState | McpOptimizerWorkerState | ReleaseTrainWorkerRecord | undefined,
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

function designSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("design");
  const bridge = new DesignBridge({
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

function apiStandardsSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("api-standards");
  const bridge = new ApiStandardsBridge({
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

function deadCodeSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("dead-code");
  const bridge = new DeadCodeBridge({
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

function singleResponsibilitySnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("single-responsibility");
  const bridge = new SingleResponsibilityBridge({
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

function mcpOptimizerSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("mcp-optimizer");
  const directory = mcpOptimizerDirectory(context.stateDir);
  const worker = readMcpOptimizerWorker(directory);
  const attached =
    worker !== undefined && worker.lifecycle !== "stopped" && pidAlive(worker.pid);
  const owned = attached && resolve(worker?.stateDir ?? "") === resolve(context.stateDir);
  const status = readMcpOptimizerStatus(directory);
  const settings = readMcpOptimizerSettings(directory);
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
      title: issue.title,
      category: issue.kind,
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

function releaseTrainSnapshot(context: McpContext): AgentSnapshot {
  const descriptor = agentRegistry.require("release-train");
  const directory = releaseTrainDirectory(context.stateDir);
  const shared = readReleaseTrainState(directory);
  const worker = releaseTrainWorkerStates(directory)[0];
  const attached = worker !== undefined && worker.lifecycle !== "stopped" && pidAlive(worker.pid);
  const owned = attached && resolve(worker?.stateDir ?? "") === resolve(context.stateDir);
  const settings = readReleaseTrainSettings(directory);
  const lifecycle = workerLifecycle(worker, attached);
  const gate = shared?.gate ?? null;
  const activity = shared?.activity ?? [];
  return projectAgentSnapshot(descriptor, {
    lifecycle,
    paused: worker?.paused === true,
    enabled: attached && worker?.enabled === true && lifecycle !== "stopped",
    owned,
    attached,
    cadence: {
      minutes: settings.intervalMinutes,
      lastRunAt: worker?.lastRunAt ?? shared?.release?.at ?? null,
      nextRunAt: attached ? (worker?.nextRunAt ?? null) : null,
    },
    limits: {
      maxPerHour: settings.maxPerHour,
      maxPending: settings.maxPending,
    },
    issues: [],
    pending: 0,
    sync: {
      state: gate === null ? "stale" : gate.state === "error" ? "error" : "ok",
      at: gate?.at ?? null,
      error: gate?.state === "error" ? gate.detail : null,
    },
    detail: {
      panel: "activity",
      scanId: `${shared?.runs[0]?.id ?? "idle"}:${activity.length}`,
      entries: activity,
    },
    notice: worker?.notice ?? null,
    error:
      (gate?.state === "error" ? gate.detail : null) ??
      worker?.lastError ??
      shared?.failure?.detail ??
      null,
    timer: null,
  });
}

function persistedAgents(context: McpContext): AgentSnapshot[] {
  return agentRegistry.descriptors.map((descriptor) => {
    if (descriptor.id === "scout") return scoutSnapshot(context);
    if (descriptor.id === "watchdog") return watchdogSnapshot(context);
    if (descriptor.id === "design") return designSnapshot(context);
    if (descriptor.id === "api-standards") return apiStandardsSnapshot(context);
    if (descriptor.id === "dead-code") return deadCodeSnapshot(context);
    if (descriptor.id === "single-responsibility") {
      return singleResponsibilitySnapshot(context);
    }
    if (descriptor.id === "release-train") return releaseTrainSnapshot(context);
    return mcpOptimizerSnapshot(context);
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
