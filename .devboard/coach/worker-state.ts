import { readFileSync } from "node:fs";
import { isInteger, isRecord, nullableString } from "../issues/guards";
import type { AgentLifecycle } from "../server/agents/registry";
import { workerStatePath, WORKER_VERSION } from "./paths";
import { writeJsonAtomic } from "../watchdog/settings";

/**
 * The detached worker's published lifecycle. The dashboard reads only this to
 * know whether Coach is starting, running, stopping, stopped, or failed.
 */
export interface CoachWorkerState {
  version: 1;
  pid: number;
  startedAt: string;
  /** The repository root the cycle reads. */
  root: string;
  /** This dashboard's state directory, which decides ownership. */
  stateDir: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  /** True once a drain arrived: the in-flight cycle finishes, then it exits. */
  draining?: boolean;
  harnessVersion: string | null;
  argv: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  notice: string | null;
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

export function parseWorkerState(text: string): CoachWorkerState | undefined {
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
  if (parsed.draining !== undefined && typeof parsed.draining !== "boolean") return undefined;
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
    ...(parsed.draining === true ? { draining: true } : {}),
    harnessVersion: parsed.harnessVersion,
    argv: parsed.argv,
    lastRunAt: parsed.lastRunAt,
    nextRunAt: parsed.nextRunAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    updatedAt: parsed.updatedAt,
  };
}

export function readWorkerState(directory: string): CoachWorkerState | undefined {
  try {
    return parseWorkerState(readFileSync(workerStatePath(directory), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeWorkerState(directory: string, state: CoachWorkerState): void {
  writeJsonAtomic(workerStatePath(directory), state);
}
