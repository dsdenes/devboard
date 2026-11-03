import type { Subprocess } from "bun";
import { spawn, type StdioOptions } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInteger, isRecord } from "../issues/guards";
import { pidAlive } from "../issues/lock";
import {
  isVerificationScratch,
  processTable,
  type ProcessSnapshot,
} from "./discovery";

/**
 * Process supervision: one spawn path, one durable record per child, one
 * reaper. A harness child is started in its own process group and recorded as
 * `{pid, argv, cwd, ownerPid, startedAt, startTicks, pgid}` before the caller
 * uses it, so a later tick can prove the child outlived its owner and end it.
 *
 * Nothing here decides what a dashboard should keep; age-based file retention
 * stays in `cleanup.ts`.
 */

/** How long an unrecorded orphan may exist before a kill is allowed. */
export const SUPERVISION_ORPHAN_GRACE_MS = 5_000;
/** How long a signalled process may take to exit before SIGKILL. */
export const SUPERVISION_KILL_GRACE_MS = 2_000;
/** The record directory inside a state directory. */
export const SUPERVISION_DIRECTORY = "supervision";
/** The one interval the watchdog schedules the reaper on. */
export const SUPERVISION_INTERVAL_MS = 30_000;
/** Linux reports a process start in USER_HZ ticks per second. */
const CLOCK_TICKS_PER_SECOND = 100;
const RECORD_VERSION = 1;

/**
 * One supervised child. `argv` and `startTicks` are read from `/proc` right
 * after the spawn, so they describe the process the kernel started rather than
 * the request the caller made; `startTicks` is what separates a live child
 * from a recycled pid.
 */
export interface SupervisionRecord {
  version: number;
  pid: number;
  argv: string[];
  cwd: string;
  ownerPid: number;
  startedAt: string;
  startTicks: number;
  pgid: number;
}

/** A state directory whose `supervision` child carries records. */
export interface SupervisionScope {
  stateDir: string;
  repoDir: string;
}

/** Where the records of one caller's children live. */
export function supervisionDirectory(stateDir: string): string {
  return join(resolve(stateDir), SUPERVISION_DIRECTORY);
}

export function supervisionRecordPath(stateDir: string, pid: number): string {
  return join(supervisionDirectory(stateDir), `${pid}.json`);
}

/**
 * The state directory a child records into when its caller names none: the
 * dashboard's own `STATE_DIR`, then the root's canonical `.devboard/.tmp`, then
 * the serving harness's own `.tmp`, which is the same directory on a source
 * checkout and the dashboard's own state directory under an install prefix.
 */
export function defaultSupervisionStateDirectory(): string {
  const fromState = process.env.STATE_DIR?.trim();
  if (fromState !== undefined && fromState.length > 0) return resolve(fromState);
  const repo = process.env.REPO_DIR?.trim();
  if (repo !== undefined && repo.length > 0) return join(resolve(repo), ".devboard", ".tmp");
  return join(resolve(import.meta.dir, ".."), ".tmp");
}

/** `/proc/<pid>/stat` fields this module needs. */
export interface ProcessStat {
  pid: number;
  ppid: number;
  /** The process group id; equal to `pid` for a supervised child. */
  pgrp: number;
  /** Field 22, in USER_HZ ticks since boot. */
  startTicks: number;
  /** Field 3, e.g. `R`, `S`, or `Z`. */
  state: string;
}

export function processStat(pid: number): ProcessStat | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // The command name may contain spaces and parentheses; fields resume after
  // the last ")". That suffix starts at field 3 (state), so ppid is index 1,
  // pgrp index 2, and starttime index 19.
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const startTicks = Number(fields[19]);
  const state = fields[0] ?? "";
  if (!Number.isFinite(ppid) || !Number.isFinite(pgrp) || !Number.isFinite(startTicks)) {
    return undefined;
  }
  return { pid, ppid, pgrp, startTicks, state };
}

/**
 * True when the pid names a running process that is not a zombie. A killed
 * child whose parent has not reaped it yet is dead for supervision's purpose.
 */
export function liveProcess(pid: number): boolean {
  const stat = processStat(pid);
  if (stat !== undefined) return stat.state !== "Z";
  return process.platform !== "linux" && pidAlive(pid);
}

/** The kernel's own argv for a process, which is what a record stores. */
export function processArgv(pid: number): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * A harness entry point that starts and owns other harness processes. A scratch
 * child with one of these in its ancestry still has an owner and is never a
 * candidate; the job runner's own subreaper is not one, so a job's orphaned
 * grandchildren stay candidates.
 */
const HARNESS_SUPERVISOR =
  /(?:^|\/)(?:server\/index\.ts|scripts\/verify-[a-z0-9-]+\.ts|watchdog\/(?:worker|main)\.ts)(?:\s|$)|(?:^|\s)bun(?:\.exe)?\s+test(?:\s|$)/;

/**
 * True when a live harness supervisor still owns the candidate through its
 * ancestor chain: a test runner, a verification script, a dashboard, or the
 * watchdog. A reparented process whose new parent is the job runner's subreaper
 * has no such ancestor and stays a candidate.
 */
function supervisedByAncestor(
  candidate: ProcessSnapshot,
  byPid: Map<number, ProcessSnapshot>,
): boolean {
  return candidate.ancestors.some((pid) => {
    const ancestor = byPid.get(pid);
    return ancestor !== undefined && HARNESS_SUPERVISOR.test(ancestor.cmdline);
  });
}

/** True when a process started less than `ms` ago. */
export function processAgeMs(pid: number): number | undefined {
  const stat = processStat(pid);
  if (stat === undefined) return undefined;
  try {
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(uptime)) return undefined;
    return Math.max(0, uptime * 1000 - (stat.startTicks * 1000) / CLOCK_TICKS_PER_SECOND);
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, path);
}

function parseRecord(value: unknown): SupervisionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { pid, ownerPid, startedAt, startTicks, pgid, cwd, argv } = value;
  if (!isInteger(pid) || pid <= 0) return undefined;
  if (!isInteger(ownerPid) || ownerPid <= 0) return undefined;
  if (typeof startedAt !== "string" || typeof cwd !== "string") return undefined;
  if (!isInteger(startTicks) || !isInteger(pgid)) return undefined;
  if (!Array.isArray(argv) || !argv.every((entry) => typeof entry === "string")) return undefined;
  return {
    version: isInteger(value.version) ? value.version : RECORD_VERSION,
    pid,
    ownerPid,
    startedAt,
    startTicks,
    pgid,
    cwd,
    argv: [...argv],
  };
}

/**
 * The kernel argv of a just-spawned child. The exec can trail the spawn by a
 * few milliseconds, so an empty read is retried briefly; a child that is gone
 * or still nameless is never recorded, because a record must describe the
 * process a later proof would signal.
 */
function readArgvSoon(pid: number): string[] | undefined {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const argv = processArgv(pid);
    if (argv !== undefined && argv.length > 0) return argv;
    if (processStat(pid) === undefined) return undefined;
    Bun.sleepSync(2);
  }
  return undefined;
}

/** Records the pid now, before the caller uses the child. */
function recordChild(stateDir: string, pid: number, cwd: string): string | undefined {
  const stat = processStat(pid);
  if (stat === undefined) return undefined;
  const argv = readArgvSoon(pid);
  if (argv === undefined) return undefined;
  const record: SupervisionRecord = {
    version: RECORD_VERSION,
    pid,
    argv,
    cwd: resolve(cwd),
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
    startTicks: stat.startTicks,
    pgid: stat.pgrp,
  };
  const path = supervisionRecordPath(stateDir, pid);
  try {
    writeJsonAtomic(path, record);
  } catch {
    // A state directory that cannot be written must not fail the spawn; the
    // child then relies on the second proof or on its owner ending it.
    return undefined;
  }
  return path;
}

export function removeSupervisionRecord(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A concurrent reaper already removed it.
  }
}

function touchRecord(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // A swept record is already gone; the child keeps its own proof.
  }
}

/** Every readable record under one state directory. */
export function readSupervisionRecords(stateDir: string): SupervisionRecord[] {
  const directory = supervisionDirectory(stateDir);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const records: SupervisionRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parseRecord(JSON.parse(readFileSync(join(directory, name), "utf8")));
      if (record !== undefined) records.push(record);
    } catch {
      // A torn record proves nothing; it is left and never a kill proof.
    }
  }
  return records;
}

/** One child a caller starts and this module records. */
export interface SupervisedSpawnOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** The state directory that carries the record; defaults as above. */
  stateDir?: string;
}

/** A child with piped stdin, stdout, and stderr. */
export type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

/**
 * Starts one long-lived child in its own process group with piped stdio and
 * records it before returning. The record leaves when the child exits.
 */
export function supervisedSpawn(
  argv: string[],
  options: SupervisedSpawnOptions,
): PipedSubprocess {
  const stateDir = options.stateDir ?? defaultSupervisionStateDirectory();
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const pid = child.pid;
  const path = pid === undefined ? undefined : recordChild(stateDir, pid, options.cwd);
  if (path !== undefined) {
    const remove = (): void => removeSupervisionRecord(path);
    void child.exited.then(remove, remove);
  }
  return child;
}

/** One detached child a caller starts and this module records. */
export interface SupervisedDetachOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** The state directory that carries the record; defaults as above. */
  stateDir?: string;
  stdio?: StdioOptions;
  /** Called with a spawn failure; the caller keeps its own wording. */
  onError?: (error: unknown) => void;
}

/**
 * Starts one detached child in its own process group and records it before
 * returning its pid. The record leaves when the child exits; a child that
 * outlives this process is removed by the reaper.
 */
export function supervisedDetach(
  argv: string[],
  options: SupervisedDetachOptions,
): number | undefined {
  if (argv.length === 0) return undefined;
  const stateDir = options.stateDir ?? defaultSupervisionStateDirectory();
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: options.stdio ?? "ignore",
    });
    const pid = child.pid;
    if (pid !== undefined) {
      const path = recordChild(stateDir, pid, options.cwd);
      if (path !== undefined) child.once("exit", () => removeSupervisionRecord(path));
    }
    child.unref();
    return pid;
  } catch (error) {
    options.onError?.(error);
    return undefined;
  }
}

/** True when the live process still is the one the record describes. */
function matchesRecord(record: SupervisionRecord): boolean {
  const stat = processStat(record.pid);
  if (stat === undefined || stat.startTicks !== record.startTicks) return false;
  const argv = processArgv(record.pid);
  if (argv === undefined) return true;
  return argv.join("\u0000") === record.argv.join("\u0000");
}

/**
 * True for a process the harness starts and supervises as a child of another:
 * a fixture peer, a run owner, a goal-draft owner, or a background worker entry
 * point of any family and any harness version. Every such process runs a file
 * inside a `.devboard` tree, so a worker name alone never marks an unrelated
 * process.
 *
 * A dashboard is deliberately not a surface here. It is reparented to PID 1 by
 * design — a replacement relaunches it detached, and a verification script
 * starts it detached — so "reparented" proves nothing for one. Its own record,
 * written by the helper, is the proof that ends it once its owner is gone.
 */
export function isSupervisedSurface(cmdline: string): boolean {
  if (!cmdline.includes(".devboard")) return false;
  const named = /(?:^|\/)(?:server\/(?:run-owner|goal-draft-owner)\.ts|server\/fixtures\/[^\s]+\.ts)/;
  if (named.test(cmdline)) return true;
  return /(?:^|\/)worker\.ts(?:\s|$)/.test(cmdline);
}

export type ReapReason = "record" | "scratch";
export type ReapAction = "killed" | "would-kill" | "skipped" | "removed-record";

/** One decision, journaled and reported. */
export interface ReapDecision {
  action: ReapAction;
  pid: number;
  reason: ReapReason;
  detail: string;
}

export interface ReapReport {
  /** False on a platform without `/proc`; nothing was signalled. */
  available: boolean;
  decisions: ReapDecision[];
  killed: number[];
  removedRecords: number[];
}

export interface ReapOptions {
  /** Every `(stateDir, repoDir)` whose records and proofs apply. */
  scopes: SupervisionScope[];
  /** Pids a live lease, handoff, or worker lock still protects. */
  protectedPids?: Set<number>;
  /** Test seam; production reads `/proc`. */
  processes?: ProcessSnapshot[];
  /** Test seam; production uses `/proc`. */
  alive?: (pid: number) => boolean;
  /** Report candidates without signalling or deleting anything. */
  dryRun?: boolean;
  /** How long an unrecorded orphan must have lived; defaults to the constant. */
  orphanGraceMs?: number;
  /** How long a signalled process may take to exit; defaults to the constant. */
  killGraceMs?: number;
}

/**
 * Signals a supervised child's whole process group, or the child alone when it
 * does not lead one; a signal to a group that is already gone is not an error.
 */
export function signalProcessGroup(pid: number, name: NodeJS.Signals): void {
  const stat = processStat(pid);
  const group = stat !== undefined && stat.pgrp === pid && pid !== process.pid ? -pid : pid;
  try {
    process.kill(group, name);
    return;
  } catch {
    // The group is gone; fall through to the process itself.
  }
  try {
    process.kill(pid, name);
  } catch {
    // Already exited.
  }
}

function waitForExit(pid: number, alive: (pid: number) => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    if (process.platform !== "linux") return false;
    Bun.sleepSync(20);
  }
  return !alive(pid);
}

/** Ends one child and its group: SIGTERM, then SIGKILL after the grace. */
function terminate(
  pid: number,
  alive: (pid: number) => boolean,
  killGraceMs: number,
): void {
  signalProcessGroup(pid, "SIGTERM");
  if (waitForExit(pid, alive, killGraceMs)) return;
  signalProcessGroup(pid, "SIGKILL");
  waitForExit(pid, alive, killGraceMs);
}

/**
 * One reaping pass. Records are the first proof: a recorded child whose owner
 * is dead and whose argv and start ticks still match is killed and its record
 * removed; a recorded child whose owner lives is never signalled. The second
 * proof covers records that were never written: a supervised surface whose
 * cwd or `REPO_DIR` is verification scratch, whose ancestor chain reaches PID 1
 * again, and which no live harness process in that chain still owns is killed.
 * Everything a live lease, handoff, or worker lock protects is left alone, and
 * a doubt journals the candidate instead of signalling it.
 */
export function reapOrphans(options: ReapOptions): ReapReport {
  const report: ReapReport = {
    available: process.platform === "linux",
    decisions: [],
    killed: [],
    removedRecords: [],
  };
  if (!report.available) return report;
  const alive = options.alive ?? liveProcess;
  const protectedPids = options.protectedPids ?? new Set<number>();
  const dryRun = options.dryRun === true;
  const orphanGraceMs = options.orphanGraceMs ?? SUPERVISION_ORPHAN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? SUPERVISION_KILL_GRACE_MS;

  // Read every record once; a pid recorded in two state directories is one child.
  const records = new Map<number, { record: SupervisionRecord; path: string }>();
  for (const scope of options.scopes) {
    for (const record of readSupervisionRecords(scope.stateDir)) {
      if (records.has(record.pid)) continue;
      records.set(record.pid, {
        record,
        path: supervisionRecordPath(scope.stateDir, record.pid),
      });
    }
  }

  // A killed owner frees its own children on the next round, so a tree falls
  // in one pass instead of one per interval.
  const handled = new Set<number>();
  for (let round = 0; round < 4; round += 1) {
    let acted = false;
    for (const [pid, entry] of records) {
      if (handled.has(pid)) continue;
      const { record, path } = entry;
      if (!alive(pid)) {
        if (!dryRun) {
          removeSupervisionRecord(path);
          report.removedRecords.push(pid);
        }
        records.delete(pid);
        handled.add(pid);
        acted = true;
        continue;
      }
      if (!matchesRecord(record)) {
        // The pid was recycled; the record describes a process that is gone.
        if (!dryRun) removeSupervisionRecord(path);
        records.delete(pid);
        handled.add(pid);
        continue;
      }
      if (alive(record.ownerPid)) {
        touchRecord(path);
        continue;
      }
      if (protectedPids.has(pid)) {
        touchRecord(path);
        report.decisions.push({
          action: "skipped",
          pid,
          reason: "record",
          detail: "a live lease, handoff, or worker lock protects this child",
        });
        handled.add(pid);
        continue;
      }
      const detail = `owner ${record.ownerPid} is gone; argv and start time match`;
      if (dryRun) {
        report.decisions.push({ action: "would-kill", pid, reason: "record", detail });
        handled.add(pid);
        continue;
      }
      terminate(pid, alive, killGraceMs);
      removeSupervisionRecord(path);
      report.decisions.push({ action: "killed", pid, reason: "record", detail });
      report.killed.push(pid);
      records.delete(pid);
      handled.add(pid);
      acted = true;
    }
    if (!acted) break;
  }

  const processes = options.processes ?? processTable();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const selfPid = process.pid;
  for (const candidate of processes) {
    const pid = candidate.pid;
    // The reaper's own descendants are its caller's work, never candidates.
    if (pid === selfPid || candidate.ancestors.includes(selfPid)) continue;
    if (records.has(pid) || handled.has(pid)) continue;
    if (!isSupervisedSurface(candidate.cmdline)) continue;
    const repoDir = candidate.env.get("REPO_DIR");
    const scratch =
      (candidate.cwd !== undefined && isVerificationScratch(candidate.cwd)) ||
      (repoDir !== undefined && isVerificationScratch(repoDir));
    if (!scratch) continue;
    // A live harness ancestor still owns the process; only an orphan is a
    // candidate.
    if (supervisedByAncestor(candidate, byPid)) continue;
    if (!alive(pid)) continue;
    const age = processAgeMs(pid);
    if (age !== undefined && age < orphanGraceMs) continue;
    if (protectedPids.has(pid)) {
      report.decisions.push({
        action: "skipped",
        pid,
        reason: "scratch",
        detail: "a live lease, handoff, or worker lock protects this process",
      });
      continue;
    }
    const detail = "no record, verification scratch, and no live harness ancestor";
    if (dryRun) {
      report.decisions.push({ action: "would-kill", pid, reason: "scratch", detail });
      continue;
    }
    terminate(pid, alive, killGraceMs);
    report.decisions.push({ action: "killed", pid, reason: "scratch", detail });
    report.killed.push(pid);
  }

  return report;
}

export interface OrphanSupervisorOptions {
  /** One reaping pass; the caller wires this to `reapOrphans`. */
  reap: () => void;
  intervalMs?: number;
  /** Test seam; production uses the runtime's timer. */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export interface OrphanSupervisor {
  stop(): void;
}

/**
 * Runs one pass now, then one every `intervalMs`. The interval has nothing to
 * do with a watchdog cycle cadence: a leaked child is reaped even while the
 * cycle is idle.
 */
export function startOrphanSupervisor(options: OrphanSupervisorOptions): OrphanSupervisor {
  const setIntervalFn =
    options.setInterval ?? ((handler: () => void, ms: number): unknown => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearInterval ??
    ((timer: unknown): void => clearInterval(timer as Parameters<typeof clearInterval>[0]));
  options.reap();
  const timer = setIntervalFn(() => options.reap(), options.intervalMs ?? SUPERVISION_INTERVAL_MS);
  return {
    stop: () => clearIntervalFn(timer),
  };
}
