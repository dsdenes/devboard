import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { journalFile } from "../server/journal";

/**
 * Instance discovery is deliberately independent of `scripts/publish.ts`: it
 * sees every dashboard on the machine, whichever harness checkout serves it,
 * and it never depends on a dashboard's state file.
 */

export interface ProcessSnapshot {
  pid: number;
  cmdline: string;
  env: Map<string, string>;
  cwd?: string;
  /** Process ids from the parent upward, nearest first. */
  ancestors: number[];
}

export interface Instance {
  pid: number;
  port: number;
  repoDir: string;
  host: string;
  /** Harness directory that serves this dashboard. */
  harness: string;
  /** The dashboard's own state directory, from `STATE_DIR`. */
  stateDir: string;
  journal: string;
  /** False when the serving harness never wrote a journal for this project. */
  instrumented: boolean;
  /** Legacy `.tmp/devboard-<cksum>.log` the starter script wrote, when present. */
  legacyLog?: string;
}

/**
 * POSIX `cksum` (CRC-32 with the length trailer) as the legacy starter script
 * computed it for the old log name. The checksum is only a file name.
 */
export function posixCksum(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      crc >>>= 0;
    }
  }
  for (let length = data.length; length > 0; length = Math.floor(length / 256)) {
    crc ^= (length & 0xff) << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      crc >>>= 0;
    }
  }
  return ~crc >>> 0;
}

export function legacyLogPath(harness: string, repoDir: string): string {
  return join(harness, ".tmp", `devboard-${posixCksum(Buffer.from(repoDir))}.log`);
}

function real(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Resolves the harness that serves an instance from its STATIC_DIR or cwd. */
export function servingHarness(process: ProcessSnapshot): string | undefined {
  const staticDir = process.env.get("STATIC_DIR");
  if (staticDir !== undefined) {
    const harness = real(dirname(staticDir));
    if (harness !== undefined) return harness;
  }
  return real(process.cwd);
}

/**
 * True when a dashboard serves a repository inside harness verification
 * scratch (`<anything>/.devboard/.tmp`). Verification scripts create hosts
 * there and deliberately fail update checks, installs, and servers; that
 * evidence proves the script's assertion, not a defect an operator must see.
 * Such a fixture opts in with `DEVBOARD_WATCHDOG_FIXTURE=1` when a live cycle
 * must still discover it.
 */
export function isVerificationScratch(repoDir: string): boolean {
  const segments = repoDir.split(/[\\/]+/);
  return segments.some(
    (segment, index) => segment === ".devboard" && segments[index + 1] === ".tmp",
  );
}

/**
 * The live watchdog verification seeds a scratch dashboard on purpose and must
 * still be discovered; every other fixture stays invisible.
 */
const WATCHDOG_FIXTURE_ENV = "DEVBOARD_WATCHDOG_FIXTURE";

/**
 * Builds instances from a process table. Excludes the watchdog, its
 * descendants, and verification fixtures unless they opt in, de-duplicates by
 * `(REPO_DIR, PORT)`, and resolves the journal and legacy log through the
 * serving harness.
 */
export function instancesFromProcesses(
  processes: ProcessSnapshot[],
  options: { selfPids: Set<number> },
): Instance[] {
  const ordered = [...processes].sort((left, right) => left.pid - right.pid);
  const seen = new Set<string>();
  const instances: Instance[] = [];
  for (const process of ordered) {
    if (options.selfPids.has(process.pid)) continue;
    if (process.ancestors.some((pid) => options.selfPids.has(pid))) continue;
    if (!process.cmdline.includes("server/index.ts")) continue;
    const repoDir = process.env.get("REPO_DIR");
    const port = Number(process.env.get("PORT"));
    if (repoDir === undefined || !Number.isInteger(port) || port <= 0) continue;
    if (
      isVerificationScratch(repoDir) &&
      process.env.get(WATCHDOG_FIXTURE_ENV) !== "1"
    ) {
      continue;
    }
    const harness = servingHarness(process);
    if (harness === undefined) continue;
    const key = `${repoDir}\0${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An installed dashboard keeps its journal beside its npm prefix, named by
    // STATE_DIR; the serving package's own `.tmp` is read-only to it.
    const stateDir = process.env.get("STATE_DIR") ?? join(harness, ".tmp");
    const journal = journalFile(stateDir, repoDir);
    const legacy = legacyLogPath(harness, repoDir);
    instances.push({
      pid: process.pid,
      port,
      repoDir,
      host: process.env.get("HOST") ?? "127.0.0.1",
      harness,
      stateDir,
      journal,
      instrumented: existsSync(join(stateDir, "journal")),
      ...(existsSync(legacy) ? { legacyLog: legacy } : {}),
    });
  }
  return instances;
}

function readStatus(pid: number): { ppid?: number } {
  try {
    for (const line of readFileSync(`/proc/${pid}/status`, "utf8").split("\n")) {
      if (line.startsWith("PPid:")) return { ppid: Number(line.slice(5).trim()) };
    }
  } catch {
    // The process exited.
  }
  return {};
}

/** The parent chain of a pid, nearest first, stopping at pid 1 or a cycle. */
export function ancestry(pid: number, limit = 64): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = readStatus(pid).ppid;
  while (current !== undefined && current > 1 && !seen.has(current) && chain.length < limit) {
    chain.push(current);
    seen.add(current);
    current = readStatus(current).ppid;
  }
  return chain;
}

export function processSnapshot(pid: number): ProcessSnapshot | undefined {
  let cmdline: string;
  let env = new Map<string, string>();
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return undefined;
  }
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0) env.set(entry.slice(0, split), entry.slice(split + 1));
    }
  } catch {
    env = new Map();
  }
  let cwd: string | undefined;
  try {
    cwd = realpathSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = undefined;
  }
  return { pid, cmdline, env, cwd, ancestors: ancestry(pid) };
}

/** Every process on the machine, read from `/proc`. */
export function processTable(): ProcessSnapshot[] {
  const processes: ProcessSnapshot[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return processes;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const snapshot = processSnapshot(Number(entry));
    if (snapshot !== undefined) processes.push(snapshot);
  }
  return processes;
}

export interface DiscoveryOptions {
  /** Pids that are the watchdog itself and its descendants. */
  selfPids?: Set<number>;
  /** Injectable process table for tests. */
  processes?: ProcessSnapshot[];
}

export function discoverInstances(options: DiscoveryOptions = {}): Instance[] {
  const selfPids = options.selfPids ?? new Set([process.pid]);
  const processes = options.processes ?? processTable();
  return instancesFromProcesses(processes, { selfPids });
}

/** True when the pid, or any ancestor, belongs to the watchdog. */
export function isOwnProcess(pid: number, selfPids: Set<number>): boolean {
  if (selfPids.has(pid)) return true;
  return ancestry(pid).some((ancestor) => selfPids.has(ancestor));
}
