import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { orchestratorDirectory } from "./state";

/**
 * One lock serialises every invocation that shares a state directory: the
 * systemd service and any manual `bun run orchestrator`. The file records the
 * owner's pid and start time, so a killed process cannot wedge the loop
 * forever and a recycled pid is not mistaken for the owner.
 */

export interface LockOwner {
  pid: number;
  /** ISO 8601 start time of the owning process, from its own clock. */
  startedAt: string;
}

export type LockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; owner?: LockOwner };

export function lockPath(stateDir: string): string {
  return join(orchestratorDirectory(stateDir), "lock");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return undefined;
    if (typeof record.startedAt !== "string") return undefined;
    return { pid: record.pid, startedAt: record.startedAt };
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock, or reports the live owner. A lock whose owner is gone is
 * reclaimed once; a second failure means a concurrent invocation won the race.
 */
export function acquireLock(path: string): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      writeSync(descriptor, `${JSON.stringify(owner)}\n`);
      return {
        acquired: true,
        release() {
          const current = readOwner(path);
          if (current !== undefined && current.pid !== process.pid) return;
          try {
            unlinkSync(path);
          } catch {
            // Another invocation, or the operator, already removed it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readOwner(path);
      if (holder !== undefined && pidAlive(holder.pid)) {
        return { acquired: false, owner: holder };
      }
      // The owner exited without releasing, or the file is unreadable.
      try {
        unlinkSync(path);
      } catch {
        // A concurrent invocation removed it first; retry the exclusive create.
      }
    }
  }
  return { acquired: false };
}
