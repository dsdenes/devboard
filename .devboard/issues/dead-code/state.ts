import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord, nullableString } from "../guards";
import {
  CADENCE_MAX_MINUTES,
  CADENCE_MIN_MINUTES,
  CYCLE_ISSUE_LIMIT,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_MAX_PENDING,
  HOUR_MS,
  LIMIT_MAX,
  LIMIT_MIN,
  STATE_VERSION,
} from "./paths";

/**
 * The Dead Code worker's published state. The detached worker writes it
 * atomically before publishing anything; a dashboard only reads it.
 */

export type DeadCodeLifecycle = "stopped" | "idle" | "detecting" | "failed";
export type DeadCodeIssueState = "pending" | "implemented";
export type DeadCodeSyncState = "ok" | "error" | "stale";

export interface DeadCodeWorkerRecord {
  pid: number;
  startedAt: string;
  stateDir: string;
  harnessVersion: string | null;
  argv: string[];
}

export interface DeadCodeLimits {
  /** Empty means unlimited. */
  maxPerHour: number | null;
  /** Empty means unlimited. */
  maxPending: number | null;
}

export interface DeadCodeSettings extends DeadCodeLimits {
  intervalMinutes: number;
}

export interface DeadCodeIssueRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  state: DeadCodeIssueState;
  category: string | null;
  /** The earliest published release that shipped the closing commit, or null. */
  version: string | null;
}

export interface DeadCodeSync {
  state: DeadCodeSyncState;
  at: string | null;
  error: string | null;
}

export interface DeadCodeState {
  version: 1;
  repo: string;
  root: string;
  lifecycle: DeadCodeLifecycle;
  enabled: boolean;
  worker: DeadCodeWorkerRecord | null;
  limits: DeadCodeLimits;
  intervalMinutes: number;
  /** The start of the newest cycle, so cadence survives a restart. */
  lastCycleStartedAt: string | null;
  issues: DeadCodeIssueRow[];
  sync: DeadCodeSync;
  /** The newest cycle, running or finished, so its activity can be replayed. */
  newestCycleId: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  notice: string | null;
  /** True while the worker waits for its in-flight cycle before exiting. */
  draining: boolean;
  updatedAt: string;
}

export const DEFAULT_LIMITS: DeadCodeLimits = Object.freeze({
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  maxPending: DEFAULT_MAX_PENDING,
});

export const DEFAULT_SETTINGS: DeadCodeSettings = Object.freeze({
  ...DEFAULT_LIMITS,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
});

export interface DeadCodeCapacity {
  /** How many issues a cycle may create. */
  batch: number;
  windowCount: number;
  openCount: number;
  hourlyRoom: number;
  pendingRoom: number;
}

/**
 * The effective room under both caps. The hourly window counts every
 * `dead-code` issue created inside it, in any state; the pending cap counts
 * open ones. One cycle files no more than the smaller room and 100.
 */
export function capacityFor(
  issues: readonly DeadCodeIssueRow[],
  limits: DeadCodeLimits,
  now: Date,
): DeadCodeCapacity {
  const windowStart = now.getTime() - HOUR_MS;
  let windowCount = 0;
  let openCount = 0;
  for (const issue of issues) {
    const createdAt = Date.parse(issue.createdAt);
    if (Number.isFinite(createdAt) && createdAt > windowStart) windowCount += 1;
    if (issue.state === "pending") openCount += 1;
  }
  const hourlyRoom =
    limits.maxPerHour === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, limits.maxPerHour - windowCount);
  const pendingRoom =
    limits.maxPending === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, limits.maxPending - openCount);
  return {
    batch: Math.min(hourlyRoom, pendingRoom, CYCLE_ISSUE_LIMIT),
    windowCount,
    openCount,
    hourlyRoom,
    pendingRoom,
  };
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX);
}

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= CADENCE_MIN_MINUTES && value <= CADENCE_MAX_MINUTES;
}

export function isLimits(value: unknown): value is DeadCodeLimits {
  return isRecord(value) && isValidLimit(value.maxPerHour) && isValidLimit(value.maxPending);
}

function isIssueState(value: unknown): value is DeadCodeIssueState {
  return value === "pending" || value === "implemented";
}

function isIssueRow(value: unknown): value is DeadCodeIssueRow {
  return (
    isRecord(value) &&
    isInteger(value.number) &&
    value.number > 0 &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.createdAt === "string" &&
    isIssueState(value.state) &&
    nullableString(value.category) &&
    nullableString(value.version)
  );
}

function isSync(value: unknown): value is DeadCodeSync {
  return (
    isRecord(value) &&
    (value.state === "ok" || value.state === "error" || value.state === "stale") &&
    nullableString(value.at) &&
    nullableString(value.error)
  );
}

function isWorker(value: unknown): value is DeadCodeWorkerRecord {
  return (
    isRecord(value) &&
    isInteger(value.pid) &&
    typeof value.startedAt === "string" &&
    typeof value.stateDir === "string" &&
    nullableString(value.harnessVersion) &&
    Array.isArray(value.argv) &&
    value.argv.every((entry) => typeof entry === "string")
  );
}

function isLifecycle(value: unknown): value is DeadCodeLifecycle {
  return (
    value === "stopped" || value === "idle" || value === "detecting" || value === "failed"
  );
}

export function emptyState(options: {
  repo: string;
  root: string;
  lifecycle?: DeadCodeLifecycle;
  limit?: DeadCodeLimits;
  intervalMinutes?: number;
  now?: Date;
}): DeadCodeState {
  return {
    version: STATE_VERSION,
    repo: options.repo,
    root: options.root,
    lifecycle: options.lifecycle ?? "stopped",
    enabled: false,
    worker: null,
    limits: options.limit ?? { ...DEFAULT_LIMITS },
    intervalMinutes: options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    lastCycleStartedAt: null,
    issues: [],
    sync: { state: "stale", at: null, error: null },
    newestCycleId: null,
    nextAttemptAt: null,
    lastError: null,
    notice: null,
    draining: false,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

export function parseState(text: string): DeadCodeState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return undefined;
  if (typeof parsed.repo !== "string" || typeof parsed.root !== "string") return undefined;
  if (!isLifecycle(parsed.lifecycle)) return undefined;
  if (typeof parsed.enabled !== "boolean") return undefined;
  if (parsed.worker !== null && !isWorker(parsed.worker)) return undefined;
  if (!isLimits(parsed.limits)) return undefined;
  if (!isValidCadence(parsed.intervalMinutes)) return undefined;
  if (!nullableString(parsed.lastCycleStartedAt)) return undefined;
  if (!Array.isArray(parsed.issues) || !parsed.issues.every(isIssueRow)) return undefined;
  if (!isSync(parsed.sync)) return undefined;
  if (!nullableString(parsed.newestCycleId)) return undefined;
  if (!nullableString(parsed.nextAttemptAt) || !nullableString(parsed.lastError)) return undefined;
  if (!nullableString(parsed.notice)) return undefined;
  if (parsed.draining !== undefined && typeof parsed.draining !== "boolean") return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;
  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    lifecycle: parsed.lifecycle,
    enabled: parsed.enabled,
    worker: parsed.worker as DeadCodeWorkerRecord | null,
    limits: parsed.limits,
    intervalMinutes: parsed.intervalMinutes,
    lastCycleStartedAt: parsed.lastCycleStartedAt,
    issues: parsed.issues,
    sync: parsed.sync,
    newestCycleId: parsed.newestCycleId,
    nextAttemptAt: parsed.nextAttemptAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    draining: parsed.draining === true,
    updatedAt: parsed.updatedAt,
  };
}

export function readState(path: string): DeadCodeState | undefined {
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads and moves an unusable file aside, preserved. */
export function loadState(path: string): DeadCodeState | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const state = parseState(text);
  if (state !== undefined) return state;
  quarantine(path);
  return undefined;
}

export function quarantine(path: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const target = `${path}.invalid-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (existsSync(target)) continue;
    try {
      renameSync(path, target);
      return target;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function writeState(path: string, state: DeadCodeState): void {
  writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function parseSettings(text: string): DeadCodeSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isLimits(parsed)) return undefined;
  const record = parsed as unknown as Record<string, unknown>;
  const intervalMinutes =
    record.intervalMinutes === undefined
      ? DEFAULT_INTERVAL_MINUTES
      : isValidCadence(record.intervalMinutes)
        ? record.intervalMinutes
        : undefined;
  if (intervalMinutes === undefined) return undefined;
  return {
    maxPerHour: parsed.maxPerHour,
    maxPending: parsed.maxPending,
    intervalMinutes,
  };
}

export function readSettings(path: string): DeadCodeSettings | undefined {
  try {
    return parseSettings(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeSettings(path: string, settings: DeadCodeSettings): void {
  writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** The `## Category` line of an issue body, for adopted rows. */
export function categoryFromBody(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === "## category");
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value.length === 0) continue;
    if (value.startsWith("#")) return null;
    return value.length <= 40 ? value : null;
  }
  return null;
}
