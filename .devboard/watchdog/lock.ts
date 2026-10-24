import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One machine-wide lock serialises every watchdog invocation. The lock file
 * records the owner's pid, so a crashed run cannot wedge the timer forever.
 */

export type LockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; owner?: number };

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function owner(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function acquireLock(path: string): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      writeSync(descriptor, `${process.pid}\n`);
      return {
        acquired: true,
        release() {
          try {
            unlinkSync(path);
          } catch {
            // Another cycle or the operator already removed it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = owner(path);
      if (holder !== undefined && pidAlive(holder)) {
        return { acquired: false, owner: holder };
      }
      // The owner exited without releasing; reclaim the lock once.
      try {
        unlinkSync(path);
      } catch {
        // A concurrent invocation won the race.
      }
    }
  }
  return { acquired: false };
}
