import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord, nullableString } from "../guards";
import {
  CADENCE_MAX_MINUTES,
  CADENCE_MIN_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_MAX_PENDING,
  LIMIT_MAX,
  LIMIT_MIN,
  SCAN_VERSION,
  STATE_VERSION,
  scanFilePath,
} from "./paths";

/**
 * The scout worker's published state. It is the whole contract between the
 * detached worker and whatever dashboard is attached: the worker writes it
 * atomically before publishing anything, and a dashboard only ever reads it.
 * A file this module cannot understand is renamed aside, never deleted; a
 * version-1 file is migrated instead, discarding every staged recommendation.
 */

export type ScoutLifecycle = "stopped" | "idle" | "scanning" | "failed";
export type ScoutScanStatus = "running" | "succeeded" | "failed" | "stopped";
export type ScoutIssueState = "pending" | "implemented";
export type ScoutSyncState = "ok" | "error" | "stale";

export interface ScoutWorkerRecord {
  pid: number;
  startedAt: string;
  stateDir: string;
  harnessVersion: string | null;
  argv: string[];
}

export interface ScoutAcpChild {
  pid: number;
  argv: string[];
  cwd: string;
}

/** The adjustable caps the dashboard persists and the worker enforces. */
export interface ScoutLimits {
  /** Empty means unlimited. */
  maxPerHour: number | null;
  /** Empty means unlimited. */
  maxPending: number | null;
}

/** Everything the dashboard persists for a repository's worker. */
export interface ScoutSettings extends ScoutLimits {
  /** How many minutes must pass between scan starts. */
  intervalMinutes: number;
}

/** One Auto Scout issue, as GitHub last reported it. */
export interface ScoutIssueRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  /** An open issue is `pending`; a closed one is `implemented`. */
  state: ScoutIssueState;
  /** The recommendation's category, the body's `## Category`, or null. */
  category: string | null;
  /** The earliest published release that shipped the closing commit, or null. */
  version: string | null;
  /** When release resolution was last attempted for a null `version`, or null. */
  versionAttemptAt: string | null;
  /** Why the last attempt produced no version, or null. */
  versionError: string | null;
}

/** The last periodic GitHub read and whether it succeeded. */
export interface ScoutSync {
  state: ScoutSyncState;
  /** The last successful read, or null before one. */
  at: string | null;
  /** Why the last read failed, or null. */
  error: string | null;
}

export interface ScoutScanRecord {
  scanId: string;
  startedAt: string;
  /** How many recommendations the request asked for. */
  requested: number;
}

export interface ScoutState {
  version: 2;
  repo: string;
  root: string;
  lifecycle: ScoutLifecycle;
  enabled: boolean;
  worker: ScoutWorkerRecord | null;
  limits: ScoutLimits;
  /** The persisted scan cadence, in minutes. */
  intervalMinutes: number;
  /** The start of the newest scan, so cadence survives a restart. */
  lastScanStartedAt: string | null;
  /** Every Auto Scout issue known from GitHub, newest creation first. */
  issues: ScoutIssueRow[];
  /** Every open issue title the last successful read reported. */
  openTitles: string[];
  /**
   * The releases the last successful read saw. A published release changes
   * it, which lets every unresolved row attempt resolution again at once.
   */
  releaseSignature: string | null;
  sync: ScoutSync;
  scan: ScoutScanRecord | null;
  /** The newest scan, running or finished, so its activity can be replayed. */
  newestScanId: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  notice: string | null;
  updatedAt: string;
}

export const DEFAULT_LIMITS: ScoutLimits = Object.freeze({
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  maxPending: DEFAULT_MAX_PENDING,
});

export const DEFAULT_SETTINGS: ScoutSettings = Object.freeze({
  ...DEFAULT_LIMITS,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
});

/** Empty (null) is unlimited; a value is an integer from 1 through 100. */
export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX);
}

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= CADENCE_MIN_MINUTES && value <= CADENCE_MAX_MINUTES;
}

export function isLimits(value: unknown): value is ScoutLimits {
  return isRecord(value) && isValidLimit(value.maxPerHour) && isValidLimit(value.maxPending);
}

function isIssueState(value: unknown): value is ScoutIssueState {
  return value === "pending" || value === "implemented";
}

/** A stored row; the resolution fields predate the newest writer. */
type StoredIssueRow = Omit<ScoutIssueRow, "versionAttemptAt" | "versionError"> & {
  versionAttemptAt?: string | null;
  versionError?: string | null;
};

function isIssueRow(value: unknown): value is StoredIssueRow {
  return (
    isRecord(value) &&
    isInteger(value.number) &&
    value.number > 0 &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.createdAt === "string" &&
    isIssueState(value.state) &&
    nullableString(value.category) &&
    nullableString(value.version) &&
    (value.versionAttemptAt === undefined || nullableString(value.versionAttemptAt)) &&
    (value.versionError === undefined || nullableString(value.versionError))
  );
}

function storedIssueRow(row: StoredIssueRow): ScoutIssueRow {
  return {
    ...row,
    versionAttemptAt: row.versionAttemptAt ?? null,
    versionError: row.versionError ?? null,
  };
}

function isOpenTitles(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSync(value: unknown): value is ScoutSync {
  return (
    isRecord(value) &&
    (value.state === "ok" || value.state === "error" || value.state === "stale") &&
    nullableString(value.at) &&
    nullableString(value.error)
  );
}

function isWorker(value: unknown): value is ScoutWorkerRecord {
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

function isScan(value: unknown): value is ScoutScanRecord {
  return (
    isRecord(value) &&
    typeof value.scanId === "string" &&
    typeof value.startedAt === "string" &&
    isInteger(value.requested)
  );
}

function isLifecycle(value: unknown): value is ScoutLifecycle {
  return value === "stopped" || value === "idle" || value === "scanning" || value === "failed";
}

export function emptyState(options: {
  repo: string;
  root: string;
  lifecycle?: ScoutLifecycle;
  limit?: ScoutLimits;
  intervalMinutes?: number;
  now?: Date;
}): ScoutState {
  return {
    version: STATE_VERSION,
    repo: options.repo,
    root: options.root,
    lifecycle: options.lifecycle ?? "stopped",
    enabled: false,
    worker: null,
    limits: options.limit ?? { ...DEFAULT_LIMITS },
    intervalMinutes: options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    lastScanStartedAt: null,
    issues: [],
    openTitles: [],
    releaseSignature: null,
    sync: { state: "stale", at: null, error: null },
    scan: null,
    newestScanId: null,
    nextAttemptAt: null,
    lastError: null,
    notice: null,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Parses one version-2 document; `undefined` means the bytes are not ours. */
export function parseState(text: string): ScoutState | undefined {
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
  const intervalMinutes =
    parsed.intervalMinutes === undefined
      ? DEFAULT_INTERVAL_MINUTES
      : isValidCadence(parsed.intervalMinutes)
        ? parsed.intervalMinutes
        : undefined;
  if (intervalMinutes === undefined) return undefined;
  const lastScanStartedAt =
    parsed.lastScanStartedAt === undefined ? null : nullableString(parsed.lastScanStartedAt) ? parsed.lastScanStartedAt : undefined;
  if (lastScanStartedAt === undefined) return undefined;
  if (!Array.isArray(parsed.issues) || !parsed.issues.every(isIssueRow)) return undefined;
  const openTitles = parsed.openTitles === undefined ? [] : parsed.openTitles;
  if (!isOpenTitles(openTitles)) return undefined;
  const releaseSignature =
    parsed.releaseSignature === undefined
      ? null
      : nullableString(parsed.releaseSignature)
        ? parsed.releaseSignature
        : undefined;
  if (releaseSignature === undefined) return undefined;
  if (!isSync(parsed.sync)) return undefined;
  if (parsed.scan !== null && !isScan(parsed.scan)) return undefined;
  if (!nullableString(parsed.newestScanId)) return undefined;
  if (!nullableString(parsed.nextAttemptAt) || !nullableString(parsed.lastError)) return undefined;
  if (!nullableString(parsed.notice)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;

  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    lifecycle: parsed.lifecycle,
    enabled: parsed.enabled,
    worker: parsed.worker as ScoutWorkerRecord | null,
    limits: parsed.limits,
    intervalMinutes,
    lastScanStartedAt,
    issues: parsed.issues.map(storedIssueRow),
    openTitles,
    releaseSignature,
    sync: parsed.sync,
    scan: parsed.scan as ScoutScanRecord | null,
    newestScanId: parsed.newestScanId,
    nextAttemptAt: parsed.nextAttemptAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    updatedAt: parsed.updatedAt,
  };
}

/**
 * A version-1 board kept only its staging array and its decisions. The worker
 * and scan facts are carried forward, the staged recommendations are discarded
 * without filing anything, and both limits take their defaults. The notice
 * names the discard so the operator sees what the upgrade dropped.
 */
export function migrateState(text: string): ScoutState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  if (typeof parsed.repo !== "string" || typeof parsed.root !== "string") return undefined;
  if (!isLifecycle(parsed.lifecycle)) return undefined;
  if (typeof parsed.enabled !== "boolean") return undefined;
  if (parsed.worker !== null && !isWorker(parsed.worker)) return undefined;
  if (!Array.isArray(parsed.staged)) return undefined;
  if (parsed.scan !== null && !isScan(parsed.scan)) return undefined;
  if (!nullableString(parsed.newestScanId)) return undefined;
  if (!nullableString(parsed.lastError) || !nullableString(parsed.notice)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;

  const discarded = parsed.staged.length;
  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    lifecycle: parsed.lifecycle,
    enabled: parsed.enabled,
    worker: parsed.worker as ScoutWorkerRecord | null,
    limits: { ...DEFAULT_LIMITS },
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastScanStartedAt: null,
    issues: [],
    openTitles: [],
    releaseSignature: null,
    sync: { state: "stale", at: null, error: null },
    scan: parsed.scan as ScoutScanRecord | null,
    newestScanId: parsed.newestScanId,
    nextAttemptAt: null,
    lastError: parsed.lastError,
    notice:
      discarded === 0
        ? parsed.notice
        : `Discarded ${discarded} staged recommendation${discarded === 1 ? "" : "s"} from the ` +
          "previous Auto Scout version; nothing was filed.",
    updatedAt: parsed.updatedAt,
  };
}

/**
 * Reads without side effects; the dashboard uses this. A version-1 file is
 * migrated in memory, so a dashboard upgraded ahead of its worker still reads
 * the worker's lifecycle and can stop it.
 */
export function readState(path: string): ScoutState | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return parseState(text) ?? migrateState(text);
  } catch {
    return undefined;
  }
}

/** Reads and migrates, moving an unusable file aside, preserved. */
export function loadState(path: string): ScoutState | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const state = parseState(text) ?? migrateState(text);
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

/** Temporary file plus rename: no reader ever sees a prefix of a state. */
export function writeState(path: string, state: ScoutState): void {
  writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/* ------------------------------------------------------------------ */
/* Persisted limits                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reads the persisted settings. A settings file written before cadence existed
 * carries only the two caps and takes the default interval.
 */
export function parseSettings(text: string): ScoutSettings | undefined {
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

export function readSettings(path: string): ScoutSettings | undefined {
  try {
    return parseSettings(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeSettings(path: string, settings: ScoutSettings): void {
  writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* Scan records                                                        */
/* ------------------------------------------------------------------ */

export interface ScoutScanFile {
  version: 2;
  scanId: string;
  repo: string;
  root: string;
  status: ScoutScanStatus;
  startedAt: string;
  finishedAt: string | null;
  requested: number;
  filed: number;
  prompt: string;
  acp: ScoutAcpChild | null;
  error: string | null;
  shortfall: string | null;
  workerPid: number;
  harnessVersion: string | null;
}

function isAcp(value: unknown): value is ScoutAcpChild {
  return (
    isRecord(value) &&
    isInteger(value.pid) &&
    Array.isArray(value.argv) &&
    value.argv.every((entry) => typeof entry === "string") &&
    typeof value.cwd === "string"
  );
}

/** Reads a version-2 record; a version-1 record's `staged` becomes `filed`. */
export function parseScanFile(text: string): ScoutScanFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.version !== 1 && parsed.version !== SCAN_VERSION) return undefined;
  if (typeof parsed.scanId !== "string" || typeof parsed.repo !== "string") return undefined;
  if (typeof parsed.root !== "string") return undefined;
  if (
    parsed.status !== "running" &&
    parsed.status !== "succeeded" &&
    parsed.status !== "failed" &&
    parsed.status !== "stopped"
  ) {
    return undefined;
  }
  if (typeof parsed.startedAt !== "string" || !nullableString(parsed.finishedAt)) return undefined;
  if (!isInteger(parsed.requested)) return undefined;
  const filed = parsed.version === 1 ? parsed.staged : parsed.filed;
  if (!isInteger(filed)) return undefined;
  if (typeof parsed.prompt !== "string") return undefined;
  if (parsed.acp !== null && !isAcp(parsed.acp)) return undefined;
  if (!nullableString(parsed.error) || !nullableString(parsed.shortfall)) return undefined;
  if (!isInteger(parsed.workerPid) || !nullableString(parsed.harnessVersion)) return undefined;
  return {
    version: SCAN_VERSION,
    scanId: parsed.scanId,
    repo: parsed.repo,
    root: parsed.root,
    status: parsed.status,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    requested: parsed.requested,
    filed,
    prompt: parsed.prompt,
    acp: parsed.acp as ScoutAcpChild | null,
    error: parsed.error,
    shortfall: parsed.shortfall,
    workerPid: parsed.workerPid,
    harnessVersion: parsed.harnessVersion,
  };
}

export function readScanFile(directory: string): ScoutScanFile | undefined {
  try {
    return parseScanFile(readFileSync(scanFilePath(directory), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeScanFile(directory: string, scan: ScoutScanFile): void {
  writeAtomic(scanFilePath(directory), `${JSON.stringify(scan, null, 2)}\n`);
}
