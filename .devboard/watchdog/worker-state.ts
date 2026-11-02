import { readFileSync } from "node:fs";
import { isInteger, isRecord, nullableString } from "../issues/guards";
import type { AgentLifecycle } from "../server/agents/registry";
import { workerStateDirectories, workerStatePath, WORKER_VERSION } from "./paths";
import { writeJsonAtomic } from "./settings";

/**
 * The detached worker's published lifecycle. It is the only thing the
 * dashboard needs to read to know whether the worker is starting, running,
 * stopping, stopped, or failed; the ledger and run reports stay read-only.
 */
export interface WatchdogWorkerState {
  version: 1;
  pid: number;
  startedAt: string;
  root: string;
  stateDir: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  harnessVersion: string | null;
  argv: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  notice: string | null;
  /** True once a newer version asked this worker to finish and exit. */
  draining?: boolean;
  updatedAt: string;
}

function isLifecycle(value: unknown): value is AgentLifecycle {
  return (
    value === "stopped" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "failed"
  );
}

export function parseWorkerState(text: string): WatchdogWorkerState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== WORKER_VERSION) return undefined;
  if (!isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
  if (typeof parsed.startedAt !== "string") return undefined;
  if (typeof parsed.root !== "string" || typeof parsed.stateDir !== "string") return undefined;
  if (!isLifecycle(parsed.lifecycle)) return undefined;
  if (typeof parsed.enabled !== "boolean") return undefined;
  if (!nullableString(parsed.harnessVersion)) return undefined;
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  if (!nullableString(parsed.lastRunAt) || !nullableString(parsed.nextRunAt)) return undefined;
  if (!nullableString(parsed.lastError) || !nullableString(parsed.notice)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;
  return {
    version: WORKER_VERSION,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    root: parsed.root,
    stateDir: parsed.stateDir,
    lifecycle: parsed.lifecycle,
    enabled: parsed.enabled,
    harnessVersion: parsed.harnessVersion,
    argv: parsed.argv,
    lastRunAt: parsed.lastRunAt,
    nextRunAt: parsed.nextRunAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    ...(parsed.draining === true ? { draining: true } : {}),
    updatedAt: parsed.updatedAt,
  };
}

export function readWorkerState(directory: string): WatchdogWorkerState | undefined {
  try {
    return parseWorkerState(readFileSync(workerStatePath(directory), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeWorkerState(directory: string, state: WatchdogWorkerState): void {
  writeJsonAtomic(workerStatePath(directory), state);
}

/** Every readable worker state: the legacy file and each version's file. */
export function readWorkerStates(directory: string): WatchdogWorkerState[] {
  const states: WatchdogWorkerState[] = [];
  const legacy = readWorkerState(directory);
  if (legacy !== undefined) states.push(legacy);
  for (const versionDirectory of workerStateDirectories(directory)) {
    const state = readWorkerState(versionDirectory);
    if (state !== undefined) states.push(state);
  }
  return states;
}

/** The newest published state, whichever version wrote it last. */
export function readNewestWorkerState(directory: string): WatchdogWorkerState | undefined {
  return [...readWorkerStates(directory)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
}
