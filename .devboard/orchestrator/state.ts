import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The orchestrator's published state. The dashboard reads it, so every write
 * is atomic (temporary file plus rename) and every read validates the version
 * before trusting a field. A file this module cannot understand is renamed
 * aside rather than deleted: the bytes stay available for diagnosis.
 */

export const STATE_VERSION = 1;

export interface OrchestratorIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

export type OrchestratorStatus = "idle" | "running" | "failed";

export interface OrchestratorState {
  version: 1;
  root: string;
  repo: string;
  status: OrchestratorStatus;
  startedAt: string | null;
  finishedAt: string | null;
  open: number;
  issues: OrchestratorIssue[];
  lastExitCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  updatedAt: string;
}

/** `<state-dir>/orchestrator`: state, ledger, lock, run logs. */
export function orchestratorDirectory(stateDir: string): string {
  return join(stateDir, "orchestrator");
}

export function statePath(stateDir: string): string {
  return join(orchestratorDirectory(stateDir), "state.json");
}

export function runsDirectory(stateDir: string): string {
  return join(orchestratorDirectory(stateDir), "runs");
}

function isIssue(value: unknown): value is OrchestratorIssue {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.number === "number" &&
    Number.isInteger(issue.number) &&
    typeof issue.title === "string" &&
    typeof issue.url === "string" &&
    typeof issue.createdAt === "string"
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Parses one state document. `undefined` means the bytes are not this
 * version's state: unparseable JSON, another version, or a field of the wrong
 * shape. Callers decide whether that is a quarantine or a `present: false`.
 */
export function parseState(text: string): OrchestratorState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== STATE_VERSION) return undefined;
  if (typeof record.root !== "string" || typeof record.repo !== "string") return undefined;
  if (record.status !== "idle" && record.status !== "running" && record.status !== "failed") {
    return undefined;
  }
  if (typeof record.open !== "number" || !Number.isInteger(record.open) || record.open < 0) {
    return undefined;
  }
  if (!Array.isArray(record.issues) || !record.issues.every(isIssue)) return undefined;
  if (!nullableString(record.startedAt) || !nullableString(record.finishedAt)) return undefined;
  if (!nullableString(record.nextAttemptAt) || !nullableString(record.lastError)) return undefined;
  if (record.lastExitCode !== null && typeof record.lastExitCode !== "number") return undefined;
  if (typeof record.updatedAt !== "string") return undefined;
  return {
    version: STATE_VERSION,
    root: record.root,
    repo: record.repo,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    open: record.open,
    issues: record.issues,
    lastExitCode: record.lastExitCode,
    lastError: record.lastError,
    nextAttemptAt: record.nextAttemptAt,
    updatedAt: record.updatedAt,
  };
}

/** Reads a state file without side effects; the dashboard uses this. */
export function readStateFile(path: string): OrchestratorState | undefined {
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch {
    // Missing or unreadable: the caller reports `present: false`.
    return undefined;
  }
}

/** Reads a state file and moves an unusable one aside, preserved. */
export function loadState(stateDir: string): OrchestratorState | undefined {
  const path = statePath(stateDir);
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

/** Renames an unusable state file aside. Returns the new path when it moved. */
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

/** Writes the state by temporary file and rename, so no reader sees a prefix. */
export function writeState(stateDir: string, state: OrchestratorState): void {
  const directory = orchestratorDirectory(stateDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}
