import { readFileSync } from "node:fs";
import { isInteger, isRecord, nullableString } from "../issues/guards";
import { writeJsonAtomic } from "../watchdog/settings";
import type { AgentLifecycle } from "../server/agents/registry";
import { STATE_VERSION, WORKER_VERSION, requestPath, statePath } from "./paths";

/**
 * The Release Train's shared, durable record. Every worker version writes the
 * same release history, gate verdict, failure, and activity; the dashboard
 * reads them without a worker. Each version also publishes its own worker
 * record so a takeover can see which process holds the cadence.
 */

export type ReleaseTrainGateState = "nothing" | "unreleased" | "error";
export type ReleaseTrainRunState = "running" | "released" | "failed" | "nothing" | "error";

export interface ReleaseTrainRelease {
  version: string;
  url: string;
  at: string;
  sha: string;
  range: string;
}

export interface ReleaseTrainFailure {
  at: string;
  detail: string;
  sha: string;
  range: string;
  /** The version the failed range would have released, when known. */
  version: string | null;
}

export interface ReleaseTrainGateRecord {
  at: string;
  state: ReleaseTrainGateState;
  detail: string | null;
  target: string | null;
  range: string | null;
  version: string | null;
}

export interface ReleaseTrainRun {
  id: string;
  startedAt: string;
  endedAt: string | null;
  state: ReleaseTrainRunState;
  range: string;
  target: string;
  version: string | null;
  url: string | null;
  detail: string | null;
  /** Non-merge commits in the range; null when the gate carried no commit list. */
  commits: number | null;
}

export interface ReleaseTrainState {
  version: 1;
  repo: string;
  root: string;
  /** The newest verified release; null until the train ships one. */
  release: ReleaseTrainRelease | null;
  /** The newest failed release, kept until a later run succeeds. */
  failure: ReleaseTrainFailure | null;
  gate: ReleaseTrainGateRecord | null;
  /** Newest run first, bounded. */
  runs: ReleaseTrainRun[];
  /** The newest activity lines, oldest first, bounded. */
  activity: string[];
  updatedAt: string;
}

export const RUN_HISTORY_LIMIT = 20;
export const ACTIVITY_MAX_ENTRIES = 200;
export const ACTIVITY_MAX_BYTES = 96 * 1024;

export function emptyState(options: { repo: string; root: string; now?: Date }): ReleaseTrainState {
  return {
    version: STATE_VERSION,
    repo: options.repo,
    root: options.root,
    release: null,
    failure: null,
    gate: null,
    runs: [],
    activity: [],
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

function isRelease(value: unknown): value is ReleaseTrainRelease {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.url === "string" &&
    typeof value.at === "string" &&
    typeof value.sha === "string" &&
    typeof value.range === "string"
  );
}

function isFailure(value: unknown): value is ReleaseTrainFailure {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.detail === "string" &&
    typeof value.sha === "string" &&
    typeof value.range === "string" &&
    nullableString(value.version)
  );
}

function isGate(value: unknown): value is ReleaseTrainGateRecord {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    (value.state === "nothing" || value.state === "unreleased" || value.state === "error") &&
    nullableString(value.detail) &&
    nullableString(value.target) &&
    nullableString(value.range) &&
    nullableString(value.version)
  );
}

function isRunState(value: unknown): value is ReleaseTrainRunState {
  return (
    value === "running" ||
    value === "released" ||
    value === "failed" ||
    value === "nothing" ||
    value === "error"
  );
}

function isRun(value: unknown): value is ReleaseTrainRun {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.startedAt === "string" &&
    nullableString(value.endedAt) &&
    isRunState(value.state) &&
    typeof value.range === "string" &&
    typeof value.target === "string" &&
    nullableString(value.version) &&
    nullableString(value.url) &&
    nullableString(value.detail) &&
    (value.commits === undefined ||
      value.commits === null ||
      (isInteger(value.commits) && value.commits >= 0))
  );
}

/** A run written before the count existed keeps null instead of a guess. */
function normalizeRun(run: ReleaseTrainRun): ReleaseTrainRun {
  return {
    ...run,
    commits: isInteger(run.commits) && run.commits >= 0 ? run.commits : null,
  };
}

export function parseState(text: string): ReleaseTrainState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return undefined;
  if (typeof parsed.repo !== "string" || typeof parsed.root !== "string") return undefined;
  if (parsed.release !== null && !isRelease(parsed.release)) return undefined;
  if (parsed.failure !== null && !isFailure(parsed.failure)) return undefined;
  if (parsed.gate !== null && !isGate(parsed.gate)) return undefined;
  if (!Array.isArray(parsed.runs) || !parsed.runs.every(isRun)) return undefined;
  if (!Array.isArray(parsed.activity) || !parsed.activity.every((line) => typeof line === "string")) {
    return undefined;
  }
  if (typeof parsed.updatedAt !== "string") return undefined;
  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    release: parsed.release as ReleaseTrainRelease | null,
    failure: parsed.failure as ReleaseTrainFailure | null,
    gate: parsed.gate as ReleaseTrainGateRecord | null,
    runs: (parsed.runs as ReleaseTrainRun[])
      .slice(0, RUN_HISTORY_LIMIT)
      .map(normalizeRun),
    activity: (parsed.activity as string[]).slice(-ACTIVITY_MAX_ENTRIES),
    updatedAt: parsed.updatedAt,
  };
}

export function readState(directory: string): ReleaseTrainState | undefined {
  try {
    return parseState(readFileSync(statePath(directory), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeState(directory: string, state: ReleaseTrainState): void {
  writeJsonAtomic(statePath(directory), state);
}

/**
 * The non-merge commits one persisted run released, read from the request the
 * worker handed its agent. A run written before the shared state carried the
 * count still has this record; a missing or malformed one answers null.
 */
export function readRunCommitCount(directory: string, id: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(requestPath(directory, id), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.releaseCommits)) return null;
  const count = parsed.releaseCommits.length;
  return count > 0 ? count : null;
}

/** Prepends one run and keeps the newest bounded history. */
export function recordRun(
  runs: readonly ReleaseTrainRun[],
  run: ReleaseTrainRun,
): ReleaseTrainRun[] {
  return [run, ...runs.filter((entry) => entry.id !== run.id)].slice(0, RUN_HISTORY_LIMIT);
}

/** Appends one activity line, trimming the oldest entries and bytes. */
export function appendActivity(lines: string[], text: string): string[] {
  lines.push(text);
  while (lines.length > ACTIVITY_MAX_ENTRIES) lines.shift();
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  while (bytes > ACTIVITY_MAX_BYTES && lines.length > 1) {
    const removed = lines.shift();
    bytes -= removed === undefined ? 0 : Buffer.byteLength(removed, "utf8");
  }
  return lines;
}

export interface ReleaseTrainWorkerRecord {
  version: 1;
  pid: number;
  startedAt: string;
  root: string;
  stateDir: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  paused: boolean;
  harnessVersion: string | null;
  argv: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  notice: string | null;
  /** The run this worker is executing now, or null. */
  activeRun: string | null;
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

export function parseWorkerState(text: string): ReleaseTrainWorkerRecord | undefined {
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
  if (typeof parsed.enabled !== "boolean" || typeof parsed.paused !== "boolean") return undefined;
  if (!nullableString(parsed.harnessVersion)) return undefined;
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  if (!nullableString(parsed.lastRunAt) || !nullableString(parsed.nextRunAt)) return undefined;
  if (!nullableString(parsed.lastError) || !nullableString(parsed.notice)) return undefined;
  if (!nullableString(parsed.activeRun)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;
  return {
    version: WORKER_VERSION,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    root: parsed.root,
    stateDir: parsed.stateDir,
    lifecycle: parsed.lifecycle,
    enabled: parsed.enabled,
    paused: parsed.paused,
    harnessVersion: parsed.harnessVersion,
    argv: parsed.argv,
    lastRunAt: parsed.lastRunAt,
    nextRunAt: parsed.nextRunAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    activeRun: parsed.activeRun,
    updatedAt: parsed.updatedAt,
  };
}

export function readWorkerState(directory: string): ReleaseTrainWorkerRecord | undefined {
  try {
    return parseWorkerState(readFileSync(directory, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeWorkerState(directory: string, state: ReleaseTrainWorkerRecord): void {
  writeJsonAtomic(directory, state);
}
