import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord, nullableString } from "../guards";
import { isCategory } from "./recommendation";
import { STATE_VERSION, scanFilePath } from "./paths";
import type { ScoutEvidence, ScoutRecommendation } from "./recommendation";

/**
 * The scout worker's published board. It is the whole contract between the
 * detached worker and whatever dashboard is attached: the worker writes it
 * atomically before publishing anything, and a dashboard only ever reads it.
 * A file this module cannot understand is renamed aside, never deleted.
 */

export type ScoutLifecycle = "stopped" | "idle" | "scanning" | "failed";
export type ScoutDecisionKind = "approve" | "draft" | "reject";
export type ScoutScanStatus = "running" | "succeeded" | "failed" | "stopped";

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

export interface ScoutDecision {
  id: string;
  kind: ScoutDecisionKind;
  title: string;
  at: string;
  /** The filed issue's URL, for an approval. */
  url: string | null;
  /** The draft's repository-relative path, for a drafted goal. */
  path: string | null;
}

export interface ScoutScanRecord {
  scanId: string;
  startedAt: string;
  /** How many recommendations the request asked for. */
  requested: number;
}

export interface ScoutShortfall {
  staged: number;
  /** `9 - staged`, the slots the last scan left empty. */
  missing: number;
  reason: string;
  at: string;
}

export interface ScoutState {
  version: 1;
  repo: string;
  root: string;
  lifecycle: ScoutLifecycle;
  enabled: boolean;
  worker: ScoutWorkerRecord | null;
  staged: ScoutRecommendation[];
  scan: ScoutScanRecord | null;
  /** The newest scan, running or finished, so its activity can be replayed. */
  newestScanId: string | null;
  shortfall: ScoutShortfall | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  notice: string | null;
  decisions: ScoutDecision[];
  updatedAt: string;
}

function isEvidence(value: unknown): value is ScoutEvidence {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.lines === "string" &&
    (value.quote === undefined || typeof value.quote === "string")
  );
}

function isRecommendation(value: unknown): value is ScoutRecommendation {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isCategory(value.category) &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.impact === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(isEvidence) &&
    typeof value.proposedChange === "string" &&
    Array.isArray(value.files) &&
    value.files.every((entry) => typeof entry === "string") &&
    Array.isArray(value.acceptanceCriteria) &&
    value.acceptanceCriteria.every((entry) => typeof entry === "string") &&
    typeof value.stagedAt === "string"
  );
}

function isDecision(value: unknown): value is ScoutDecision {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "approve" || value.kind === "draft" || value.kind === "reject") &&
    typeof value.title === "string" &&
    typeof value.at === "string" &&
    nullableString(value.url) &&
    nullableString(value.path)
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

function isShortfall(value: unknown): value is ScoutShortfall {
  return (
    isRecord(value) &&
    isInteger(value.staged) &&
    isInteger(value.missing) &&
    typeof value.reason === "string" &&
    typeof value.at === "string"
  );
}

export function emptyState(options: {
  repo: string;
  root: string;
  lifecycle?: ScoutLifecycle;
  now?: Date;
}): ScoutState {
  return {
    version: STATE_VERSION,
    repo: options.repo,
    root: options.root,
    lifecycle: options.lifecycle ?? "stopped",
    enabled: false,
    worker: null,
    staged: [],
    scan: null,
    newestScanId: null,
    shortfall: null,
    nextAttemptAt: null,
    lastError: null,
    notice: null,
    decisions: [],
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Parses one document; `undefined` means the bytes are not this version. */
export function parseState(text: string): ScoutState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return undefined;
  if (typeof parsed.repo !== "string" || typeof parsed.root !== "string") return undefined;
  const lifecycle = parsed.lifecycle;
  if (
    lifecycle !== "stopped" &&
    lifecycle !== "idle" &&
    lifecycle !== "scanning" &&
    lifecycle !== "failed"
  ) {
    return undefined;
  }
  if (typeof parsed.enabled !== "boolean") return undefined;
  if (parsed.worker !== null && !isWorker(parsed.worker)) return undefined;
  if (!Array.isArray(parsed.staged) || !parsed.staged.every(isRecommendation)) return undefined;
  if (parsed.scan !== null && !isScan(parsed.scan)) return undefined;
  if (!nullableString(parsed.newestScanId)) return undefined;
  if (parsed.shortfall !== null && !isShortfall(parsed.shortfall)) return undefined;
  if (!nullableString(parsed.nextAttemptAt) || !nullableString(parsed.lastError)) return undefined;
  if (!nullableString(parsed.notice)) return undefined;
  if (!Array.isArray(parsed.decisions) || !parsed.decisions.every(isDecision)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;

  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    lifecycle,
    enabled: parsed.enabled,
    worker: parsed.worker as ScoutWorkerRecord | null,
    staged: parsed.staged,
    scan: parsed.scan as ScoutScanRecord | null,
    newestScanId: parsed.newestScanId,
    shortfall: parsed.shortfall as ScoutShortfall | null,
    nextAttemptAt: parsed.nextAttemptAt,
    lastError: parsed.lastError,
    notice: parsed.notice,
    decisions: parsed.decisions,
    updatedAt: parsed.updatedAt,
  };
}

/** Reads without side effects; the dashboard uses this. */
export function readState(path: string): ScoutState | undefined {
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads and moves an unusable file aside, preserved. */
export function loadState(path: string): ScoutState | undefined {
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
/* Scan records                                                        */
/* ------------------------------------------------------------------ */

export interface ScoutScanFile {
  version: 1;
  scanId: string;
  repo: string;
  root: string;
  status: ScoutScanStatus;
  startedAt: string;
  finishedAt: string | null;
  requested: number;
  staged: number;
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

export function parseScanFile(text: string): ScoutScanFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
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
  if (!isInteger(parsed.requested) || !isInteger(parsed.staged)) return undefined;
  if (typeof parsed.prompt !== "string") return undefined;
  if (parsed.acp !== null && !isAcp(parsed.acp)) return undefined;
  if (!nullableString(parsed.error) || !nullableString(parsed.shortfall)) return undefined;
  if (!isInteger(parsed.workerPid) || !nullableString(parsed.harnessVersion)) return undefined;
  return {
    version: 1,
    scanId: parsed.scanId,
    repo: parsed.repo,
    root: parsed.root,
    status: parsed.status,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    requested: parsed.requested,
    staged: parsed.staged,
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

