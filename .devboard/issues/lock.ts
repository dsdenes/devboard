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

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  if (owner === undefined || !pidAlive(owner.pid)) return undefined;
  return owner;
}

/**
 * Takes the lock, or reports the live owner. A lock whose owner is gone is
 * reclaimed once; a second failure means a concurrent start won the race.
 */
export function acquireLock(path: string, details: Omit<LockOwner, "pid" | "startedAt">): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { ...details, pid: process.pid, startedAt: new Date().toISOString() };
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
      if (holder !== undefined && pidAlive(holder.pid)) {
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
