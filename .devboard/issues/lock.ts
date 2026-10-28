import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord } from "./guards";

/**
 * One repository-anchored lock serialises every worker start for a checkout,
 * whichever dashboard and state directory asked for it. It records the owner
 * pid and start time, so a killed worker cannot wedge the repository forever
 * and a recycled pid is not mistaken for the owner.
 */

export interface LockOwner {
  pid: number;
  /** ISO 8601 start time of the owning process, from its own clock. */
  startedAt: string;
  repo: string;
  stateDir: string;
  harnessVersion: string | null;
  argv: string[];
}

export type LockResult =
  | { acquired: true; owner: LockOwner; release: () => void }
  | { acquired: false; owner?: LockOwner };

/**
 * Linux reports the process start in `/proc/<pid>/stat` as ticks of USER_HZ,
 * which is 100 on every supported Linux build.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Slack between a recorded start and the same process's start read back from
 * `/proc`. Locks written before the start time was recorded carry the
 * acquisition instant instead, which trails the process start by startup time.
 */
const START_TIME_TOLERANCE_MS = 2_000;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The instant a live process started, in epoch milliseconds, derived from
 * `/proc/<pid>/stat` and the kernel's own uptime. Undefined when the platform
 * has no `/proc` or the process start cannot be read.
 */
function processStartedAt(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces and parentheses; fields resume after
    // the last ")". That suffix starts at field 3 (state), so starttime, field
    // 22, is index 19.
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const startTicks = Number(stat.slice(close + 2).split(" ")[19]);
    // Measured after the stat read, so process start = now - uptime + ticks.
    const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return undefined;
    return Date.now() - uptimeSeconds * 1000 + (startTicks * 1000) / CLOCK_TICKS_PER_SECOND;
  } catch {
    return undefined;
  }
}

/** The instant this process started, for the lock it writes. */
function ownStartedAt(): string {
  const started = processStartedAt(process.pid) ?? Date.now() - process.uptime() * 1000;
  return new Date(started).toISOString();
}

/**
 * True when the live process with `owner.pid` is the lock's own owner, not a
 * recycled pid. A live pid whose start does not match the recorded instant is
 * stale: the owner died and the OS reused its pid. Without an identity source
 * (no `/proc` on this platform) a live pid is the only available proof.
 */
function ownerAlive(owner: LockOwner): boolean {
  if (!pidAlive(owner.pid)) return false;
  const recorded = Date.parse(owner.startedAt);
  if (!Number.isFinite(recorded)) return false;
  const actual = processStartedAt(owner.pid);
  if (actual === undefined) return process.platform !== "linux";
  return Math.abs(actual - recorded) <= START_TIME_TOLERANCE_MS;
}

/** The lock's owner, if the file is present and readable. */
export function readLock(path: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    if (!isInteger(parsed.pid) || typeof parsed.startedAt !== "string") return undefined;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      repo: typeof parsed.repo === "string" ? parsed.repo : "",
      stateDir: typeof parsed.stateDir === "string" ? parsed.stateDir : "",
      harnessVersion: typeof parsed.harnessVersion === "string" ? parsed.harnessVersion : null,
      argv: Array.isArray(parsed.argv)
        ? parsed.argv.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return undefined;
  }
}

/** The live owner of a lock, or undefined when it is missing or stale. */
export function liveLockOwner(path: string): LockOwner | undefined {
  const owner = readLock(path);
  if (owner === undefined || !ownerAlive(owner)) return undefined;
  return owner;
}

/**
 * Takes the lock, or reports the live owner. A lock whose owner is gone or
 * whose pid was recycled is reclaimed once; a second failure means a
 * concurrent start won the race.
 */
export function acquireLock(path: string, details: Omit<LockOwner, "pid" | "startedAt">): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { ...details, pid: process.pid, startedAt: ownStartedAt() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      writeSync(descriptor, `${JSON.stringify(owner)}\n`);
      return {
        acquired: true,
        owner,
        release() {
          const current = readLock(path);
          if (current !== undefined && (current.pid !== owner.pid || current.startedAt !== owner.startedAt)) {
            return;
          }
          try {
            unlinkSync(path);
          } catch {
            // Another invocation, or the operator, already removed it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(path);
      if (holder !== undefined && ownerAlive(holder)) {
        return { acquired: false, owner: holder };
      }
      try {
        unlinkSync(path);
      } catch {
        // A concurrent start removed it first; retry the exclusive create.
      }
    }
  }
  return { acquired: false };
}
