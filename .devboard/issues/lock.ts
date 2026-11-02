import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

interface ParsedLock {
  owner: LockOwner | undefined;
  /** Per-acquisition identity; absent on locks written by older harnesses. */
  token: string | undefined;
}

function parseLock(content: string): ParsedLock {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return { owner: undefined, token: undefined };
    if (!isInteger(parsed.pid) || typeof parsed.startedAt !== "string") {
      return { owner: undefined, token: undefined };
    }
    return {
      owner: {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        repo: typeof parsed.repo === "string" ? parsed.repo : "",
        stateDir: typeof parsed.stateDir === "string" ? parsed.stateDir : "",
        harnessVersion: typeof parsed.harnessVersion === "string" ? parsed.harnessVersion : null,
        argv: Array.isArray(parsed.argv)
          ? parsed.argv.filter((entry): entry is string => typeof entry === "string")
          : [],
      },
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return { owner: undefined, token: undefined };
  }
}

/** The lock's owner, if the file is present and readable. */
export function readLock(path: string): LockOwner | undefined {
  try {
    return parseLock(readFileSync(path, "utf8")).owner;
  } catch {
    return undefined;
  }
}

/**
 * A lock file's owner together with the identity of the file that carried it.
 * The token distinguishes two lock files with the same owner fields, which is
 * exactly what a stale lock and a freshly created one by the same process look
 * like; the inode covers locks written before tokens existed.
 */
interface LockSnapshot {
  owner: LockOwner | undefined;
  token: string | undefined;
  device: number;
  inode: number;
}

/** Reads one lock file through a single descriptor, so content and identity agree. */
function readSnapshot(path: string): LockSnapshot | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(descriptor);
    const parsed = parseLock(readFileSync(descriptor, "utf8"));
    return {
      owner: parsed.owner,
      token: parsed.token,
      device: stats.dev,
      inode: stats.ino,
    };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * True when two snapshots are the same lock file. The written token is the
 * primary identity because the filesystem can reuse a freed inode for the
 * very lock that won the race; locks from older harnesses fall back to the
 * inode.
 */
function sameLockFile(left: LockSnapshot, right: LockSnapshot): boolean {
  if (left.token !== undefined || right.token !== undefined) {
    return left.token !== undefined && left.token === right.token;
  }
  return left.device === right.device && left.inode === right.inode;
}

/**
 * Reclaims `inspected` without ever deleting whatever currently sits at
 * `path` by guess. The path is moved aside atomically; only a file that is
 * still the inspected lock is discarded. A newer lock that arrived after the
 * inspection is moved back instead of being destroyed.
 */
function reclaimStaleLock(path: string, inspected: LockSnapshot): void {
  const aside = `${path}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    // A concurrent starter already removed or replaced it; retry the create.
    return;
  }
  const moved = readSnapshot(aside);
  if (moved === undefined || !sameLockFile(inspected, moved)) {
    try {
      linkSync(aside, path);
    } catch {
      // The path holds a still newer lock; leave the moved file untouched
      // rather than deleting a lock some live owner believes it holds.
      return;
    }
    try {
      unlinkSync(aside);
    } catch {
      // The restore already linked it back; the orphaned name is harmless.
    }
    return;
  }
  try {
    unlinkSync(aside);
  } catch {
    // Another reclaimer observed the same stale inode and removed it.
  }
}

/** A version-safe segment for a lock file or worker directory. */
export function workerVersionKey(version: string | null): string {
  const text = version === null || version.length === 0 ? "unknown" : version;
  return text.replace(/[^0-9A-Za-z._-]/g, "_");
}

/** A version's own lock beside a legacy lock path. */
export function versionLockPath(basePath: string, version: string | null): string {
  return `${basePath}.${workerVersionKey(version)}`;
}

/** Every live owner beside one lock path: the legacy lock and each version. */
export function liveLockOwners(path: string): LockOwner[] {
  const owners: LockOwner[] = [];
  const legacy = liveLockOwner(path);
  if (legacy !== undefined) owners.push(legacy);
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return owners;
  }
  const prefix = `${basename(path)}.`;
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || name.includes(".reclaim-") || name.includes(".new-")) continue;
    const owner = liveLockOwner(join(dirname(path), name));
    if (owner !== undefined) owners.push(owner);
  }
  return owners;
}

/** The live owner of a lock, or undefined when it is missing or stale. */
export function liveLockOwner(path: string): LockOwner | undefined {
  const owner = readLock(path);
  if (owner === undefined || !ownerAlive(owner)) return undefined;
  return owner;
}

/**
 * Takes a version's lock, treating a live legacy lock from the same version
 * (or from a worker that recorded no version) as the same worker. A legacy
 * lock of another version belongs to a parallel worker and is ignored.
 */
export function acquireWorkerLock(
  basePath: string,
  version: string | null,
  details: Omit<LockOwner, "pid" | "startedAt">,
  options: AcquireLockOptions = {},
): LockResult {
  const legacy = liveLockOwner(basePath);
  if (legacy !== undefined && (legacy.harnessVersion === null || legacy.harnessVersion === version)) {
    return { acquired: false, owner: legacy };
  }
  return acquireLock(versionLockPath(basePath, version), details, options);
}

export interface AcquireLockOptions {
  /**
   * Test seam: called with the stale holder after inspection and before
   * reclamation, so an interleaving starter can be driven deterministically.
   */
  onStaleLock?: (owner: LockOwner | undefined) => void;
}

/**
 * Takes the lock, or reports the live owner. A lock whose owner is gone or
 * whose pid was recycled is reclaimed once; a second failure means a
 * concurrent start won the race.
 */
export function acquireLock(
  path: string,
  details: Omit<LockOwner, "pid" | "startedAt">,
  options: AcquireLockOptions = {},
): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { ...details, pid: process.pid, startedAt: ownStartedAt() };
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Publish a complete lock atomically: a reader that inspects the path
      // must never see the empty or half-written window of a live lock.
      const staged = `${path}.new-${process.pid}-${randomUUID()}`;
      try {
        const descriptor = openSync(staged, "wx");
        try {
          writeSync(descriptor, `${JSON.stringify({ ...owner, token })}\n`);
        } finally {
          closeSync(descriptor);
        }
        linkSync(staged, path);
      } finally {
        try {
          unlinkSync(staged);
        } catch {
          // The staged name is removed whether the link won or lost.
        }
      }
      return {
        acquired: true,
        owner,
        release() {
          const current = readSnapshot(path);
          if (current !== undefined && current.token !== token) return;
          try {
            unlinkSync(path);
          } catch {
            // Another invocation, or the operator, already removed it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = readSnapshot(path);
      if (snapshot === undefined) continue;
      if (snapshot.owner !== undefined && ownerAlive(snapshot.owner)) {
        return { acquired: false, owner: snapshot.owner };
      }
      options.onStaleLock?.(snapshot.owner);
      reclaimStaleLock(path, snapshot);
    }
  }
  return { acquired: false };
}
