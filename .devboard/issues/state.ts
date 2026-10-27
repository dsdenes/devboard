import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInteger, isRecord, nullableString } from "./guards";
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_TRIMMED_MARKER,
  STATE_VERSION,
  runsDirectory,
} from "./paths";

/**
 * The issues worker's published state. It is the whole contract between the
 * detached worker and whatever dashboard is attached: the worker writes it
 * atomically before publishing anything, and a dashboard only ever reads it.
 * A file this module cannot understand is renamed aside, never deleted.
 */

export type IssuesLifecycle = "stopped" | "idle" | "running" | "failed";
export type IssuesRunStatus = "running" | "succeeded" | "failed" | "stopped";

export interface IssuesIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

export interface QueuedIssue extends IssuesIssue {
  handled: boolean;
  runId: string | null;
}

export interface IssuesRunSummary {
  runId: string;
  status: IssuesRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  issueNumbers: number[];
  activity: number;
  firstStderrLine: string | null;
}

export interface IssuesRunDetail extends IssuesRunSummary {
  repo: string;
  argv: string[];
  cwd: string;
  issues: IssuesIssue[];
  workerPid: number;
  harnessVersion: string | null;
  activityLines: string[];
}

export interface IssuesPollState {
  intervalMs: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  etag: string | null;
  notModified: boolean;
  rateLimitedUntil: string | null;
  error: string | null;
}

export interface IssuesWorkerRecord {
  pid: number;
  startedAt: string;
  stateDir: string;
  harnessVersion: string | null;
  argv: string[];
}

export interface IssuesAcpChild {
  pid: number;
  argv: string[];
  cwd: string;
}

/**
 * One goal-labeled issue's own peer. Each agent has a run record, activity,
 * and pending question of its own; `runId` is what routes an answer.
 */
export interface IssuesAgent {
  runId: string;
  issueNumber: number;
  startedAt: string;
  question: IssuesQuestion | null;
  acp: IssuesAcpChild | null;
}

export interface IssuesQuestion {
  id: number | string;
  message: string;
  options: Array<{ label: string; description?: string; recommended: boolean }>;
}

export interface IssuesState {
  version: 1;
  repo: string;
  root: string;
  lifecycle: IssuesLifecycle;
  enabled: boolean;
  worker: IssuesWorkerRecord | null;
  poll: IssuesPollState;
  queue: QueuedIssue[];
  runs: IssuesRunSummary[];
  activeRun: { runId: string; startedAt: string; issueNumbers: number[] } | null;
  /** One entry per concurrently running goal-labeled issue peer. */
  agents: IssuesAgent[];
  question: IssuesQuestion | null;
  acp: IssuesAcpChild | null;
  nextAttemptAt: string | null;
  /** Per-issue retry gate for a failed goal run, keyed by issue number. */
  goalCooldowns: Record<string, string>;
  lastError: string | null;
  lastExitCode: number | null;
  finishedAt: string | null;
  notice: string | null;
  updatedAt: string;
}


function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Labels are optional in files written before label-aware polling. */
function isIssue(value: unknown): value is IssuesIssue {
  return (
    isRecord(value) &&
    isInteger(value.number) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.createdAt === "string" &&
    (value.labels === undefined || isStringArray(value.labels))
  );
}

export function issueLabels(value: unknown): string[] {
  return isRecord(value) && isStringArray(value.labels) ? [...value.labels] : [];
}

function normalizedIssue(value: IssuesIssue): IssuesIssue {
  return { ...value, labels: issueLabels(value) };
}

function isQueued(value: unknown): value is QueuedIssue {
  return (
    isRecord(value) &&
    typeof value.handled === "boolean" &&
    nullableString(value.runId) &&
    isIssue(value)
  );
}

function isRunSummary(value: unknown): value is IssuesRunSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    (value.status === "running" ||
      value.status === "succeeded" ||
      value.status === "failed" ||
      value.status === "stopped") &&
    typeof value.startedAt === "string" &&
    nullableString(value.finishedAt) &&
    (value.exitCode === null || isInteger(value.exitCode)) &&
    Array.isArray(value.issueNumbers) &&
    value.issueNumbers.every(isInteger) &&
    isInteger(value.activity) &&
    nullableString(value.firstStderrLine)
  );
}

function isQuestion(value: unknown): value is IssuesQuestion {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" && !isInteger(value.id)) return false;
  if (typeof value.message !== "string") return false;
  return (
    Array.isArray(value.options) &&
    value.options.every(
      (option) =>
        isRecord(option) &&
        typeof option.label === "string" &&
        (option.description === undefined || typeof option.description === "string") &&
        typeof option.recommended === "boolean",
    )
  );
}

function isWorker(value: unknown): value is IssuesWorkerRecord {
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

function isAcp(value: unknown): value is IssuesAcpChild {
  return (
    isRecord(value) &&
    isInteger(value.pid) &&
    Array.isArray(value.argv) &&
    value.argv.every((entry) => typeof entry === "string") &&
    typeof value.cwd === "string"
  );
}

function isAgent(value: unknown): value is IssuesAgent {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    isInteger(value.issueNumber) &&
    typeof value.startedAt === "string" &&
    (value.question === null || isQuestion(value.question)) &&
    (value.acp === null || isAcp(value.acp))
  );
}

function isPoll(value: unknown): value is IssuesPollState {
  return (
    isRecord(value) &&
    isInteger(value.intervalMs) &&
    nullableString(value.lastPollAt) &&
    nullableString(value.nextPollAt) &&
    nullableString(value.etag) &&
    typeof value.notModified === "boolean" &&
    nullableString(value.rateLimitedUntil) &&
    nullableString(value.error)
  );
}

export function emptyPoll(intervalMs: number): IssuesPollState {
  return {
    intervalMs,
    lastPollAt: null,
    nextPollAt: null,
    etag: null,
    notModified: false,
    rateLimitedUntil: null,
    error: null,
  };
}

export function emptyState(options: {
  repo: string;
  root: string;
  lifecycle?: IssuesLifecycle;
  intervalMs?: number;
  now?: Date;
}): IssuesState {
  return {
    version: STATE_VERSION,
    repo: options.repo,
    root: options.root,
    lifecycle: options.lifecycle ?? "stopped",
    enabled: false,
    worker: null,
    poll: emptyPoll(options.intervalMs ?? 2000),
    queue: [],
    runs: [],
    activeRun: null,
    agents: [],
    question: null,
    acp: null,
    nextAttemptAt: null,
    goalCooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Parses one document; `undefined` means the bytes are not this version. */
export function parseState(text: string): IssuesState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return undefined;
  if (typeof parsed.repo !== "string" || typeof parsed.root !== "string") return undefined;
  const storedLifecycle = parsed.lifecycle;
  if (
    storedLifecycle !== "stopped" &&
    storedLifecycle !== "idle" &&
    storedLifecycle !== "running" &&
    storedLifecycle !== "pausing" &&
    storedLifecycle !== "paused" &&
    storedLifecycle !== "failed"
  ) {
    return undefined;
  }
  if (typeof parsed.enabled !== "boolean") return undefined;
  // `pausing` and `paused` belonged to the removed pause control: a worker
  // still enabled by such a state resumes polling instead of staying parked.
  const lifecycle: IssuesLifecycle =
    storedLifecycle === "pausing" || storedLifecycle === "paused"
      ? parsed.enabled
        ? "idle"
        : "stopped"
      : storedLifecycle;
  if (parsed.worker !== null && !isWorker(parsed.worker)) return undefined;
  if (!isPoll(parsed.poll)) return undefined;
  if (!Array.isArray(parsed.queue) || !parsed.queue.every(isQueued)) return undefined;
  if (!Array.isArray(parsed.runs) || !parsed.runs.every(isRunSummary)) return undefined;
  if (parsed.activeRun !== null) {
    if (
      !isRecord(parsed.activeRun) ||
      typeof parsed.activeRun.runId !== "string" ||
      typeof parsed.activeRun.startedAt !== "string" ||
      !Array.isArray(parsed.activeRun.issueNumbers) ||
      !parsed.activeRun.issueNumbers.every(isInteger)
    ) {
      return undefined;
    }
  }
  if (parsed.question !== null && !isQuestion(parsed.question)) return undefined;
  if (parsed.acp !== null && !isAcp(parsed.acp)) return undefined;
  if (parsed.agents !== undefined && (!Array.isArray(parsed.agents) || !parsed.agents.every(isAgent))) {
    return undefined;
  }
  if (
    parsed.goalCooldowns !== undefined &&
    (!isRecord(parsed.goalCooldowns) ||
      !Object.values(parsed.goalCooldowns).every((entry) => typeof entry === "string"))
  ) {
    return undefined;
  }
  if (!nullableString(parsed.nextAttemptAt) || !nullableString(parsed.lastError)) return undefined;
  if (parsed.lastExitCode !== null && !isInteger(parsed.lastExitCode)) return undefined;
  if (!nullableString(parsed.finishedAt)) return undefined;
  if (!nullableString(parsed.notice)) return undefined;
  if (typeof parsed.updatedAt !== "string") return undefined;

  return {
    version: STATE_VERSION,
    repo: parsed.repo,
    root: parsed.root,
    lifecycle,
    enabled: parsed.enabled,
    worker: parsed.worker as IssuesWorkerRecord | null,
    poll: parsed.poll,
    queue: parsed.queue.map((entry) => normalizedIssue(entry)) as QueuedIssue[],
    runs: parsed.runs,
    activeRun: parsed.activeRun as IssuesState["activeRun"],
    agents: (parsed.agents as IssuesAgent[] | undefined) ?? [],
    question: parsed.question as IssuesQuestion | null,
    acp: parsed.acp as IssuesAcpChild | null,
    nextAttemptAt: parsed.nextAttemptAt,
    goalCooldowns: (parsed.goalCooldowns as Record<string, string> | undefined) ?? {},
    lastError: parsed.lastError,
    lastExitCode: parsed.lastExitCode,
    finishedAt: parsed.finishedAt,
    notice: parsed.notice,
    updatedAt: parsed.updatedAt,
  };
}

/** Reads without side effects; the dashboard uses this. */
export function readState(path: string): IssuesState | undefined {
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads and moves an unusable file aside, preserved. */
export function loadState(path: string): IssuesState | undefined {
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
export function writeState(path: string, state: IssuesState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

/* ------------------------------------------------------------------ */
/* Run records and their activity                                      */
/* ------------------------------------------------------------------ */

export interface RunFile {
  version: 1;
  runId: string;
  repo: string;
  status: IssuesRunStatus;
  argv: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  issues: IssuesIssue[];
  firstStderrLine: string | null;
  workerPid: number;
  harnessVersion: string | null;
}

export function parseRunFile(text: string): RunFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  if (typeof parsed.runId !== "string" || typeof parsed.repo !== "string") return undefined;
  if (
    parsed.status !== "running" &&
    parsed.status !== "succeeded" &&
    parsed.status !== "failed" &&
    parsed.status !== "stopped"
  ) {
    return undefined;
  }
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  if (typeof parsed.cwd !== "string" || typeof parsed.startedAt !== "string") return undefined;
  if (!nullableString(parsed.finishedAt)) return undefined;
  if (parsed.exitCode !== null && !isInteger(parsed.exitCode)) return undefined;
  if (!Array.isArray(parsed.issues) || !parsed.issues.every(isIssue)) return undefined;
  if (!nullableString(parsed.firstStderrLine)) return undefined;
  if (!isInteger(parsed.workerPid)) return undefined;
  if (!nullableString(parsed.harnessVersion)) return undefined;
  return {
    version: 1,
    runId: parsed.runId,
    repo: parsed.repo,
    status: parsed.status,
    argv: parsed.argv,
    cwd: parsed.cwd,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    exitCode: parsed.exitCode,
    issues: parsed.issues.map(normalizedIssue),
    firstStderrLine: parsed.firstStderrLine,
    workerPid: parsed.workerPid,
    harnessVersion: parsed.harnessVersion,
  };
}

export function runFilePath(directory: string): string {
  return join(directory, "run.json");
}

export function activityPath(directory: string): string {
  return join(directory, "activity.json");
}

export function writeRunFile(directory: string, run: RunFile): void {
  mkdirSync(directory, { recursive: true });
  const path = runFilePath(directory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(temporary, path);
}

export function parseActivity(text: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return parsed;
}

export function readActivity(directory: string): string[] {
  try {
    return parseActivity(readFileSync(activityPath(directory), "utf8")) ?? [];
  } catch {
    return [];
  }
}

/** Atomic, so a dashboard never reads half a line. */
export function writeActivity(directory: string, lines: string[]): void {
  mkdirSync(directory, { recursive: true });
  const path = activityPath(directory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lines)}\n`);
  renameSync(temporary, path);
}

/** Per-run bound: the first of 1,000 entries or 1 MiB, with a marker. */
export function appendActivityLine(lines: string[], text: string, append: boolean): void {
  if (append && lines.length > 0) lines[lines.length - 1] += text;
  else lines.push(text);
  trimActivityLines(lines);
}

export function trimActivityLines(lines: string[]): void {
  const bytesOf = (line: string): number => Buffer.byteLength(line, "utf8");
  let bytes = 0;
  for (const line of lines) bytes += bytesOf(line);
  if (lines.length <= ACTIVITY_MAX_ENTRIES && bytes <= ACTIVITY_MAX_BYTES) return;

  const markerBytes = bytesOf(ACTIVITY_TRIMMED_MARKER);
  const kept: string[] = [];
  let keptBytes = markerBytes;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const size = bytesOf(line);
    const entries = kept.length + 2;
    if (kept.length > 0 && (entries > ACTIVITY_MAX_ENTRIES || keptBytes + size > ACTIVITY_MAX_BYTES)) {
      break;
    }
    kept.unshift(line);
    keptBytes += size;
  }
  lines.splice(0, lines.length, ACTIVITY_TRIMMED_MARKER, ...kept);
}

export function runSummary(run: RunFile, activity: number): IssuesRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    issueNumbers: run.issues.map((issue) => issue.number),
    activity,
    firstStderrLine: run.firstStderrLine,
  };
}

export function runDetail(run: RunFile, activityLines: string[]): IssuesRunDetail {
  return {
    ...runSummary(run, activityLines.length),
    repo: run.repo,
    argv: run.argv,
    cwd: run.cwd,
    issues: run.issues,
    workerPid: run.workerPid,
    harnessVersion: run.harnessVersion,
    activityLines,
  };
}

/** Newest-first run directories; the run id is a UTC timestamp name. */
export function listRunDirectories(stateDir: string, repoDir: string): string[] {
  try {
    return readdirSync(runsDirectory(stateDir, repoDir)).sort().reverse();
  } catch {
    return [];
  }
}
