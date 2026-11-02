import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { versionLockPath, workerVersionKey } from "../issues/lock";

/**
 * Every file the Coach worker owns. One instance serves one repository state
 * directory, so the dashboard's `STATE_DIR` is the only anchor: the worker,
 * its settings, control channel, ledger, lock, and runs all live under
 * `<STATE_DIR>/coach/`. The legacy worker state, control, and lock sit directly
 * there; every newer harness version gets its own directory and lock beside
 * them, so two versions can hand off without either reading the other's state.
 */

export const COACH_DIRECTORY = "coach";
export const WORKERS_DIRECTORY = "workers";
export const WORKER_VERSION = 1;
export const LEDGER_VERSION = 3;

export function coachDirectory(stateDir: string): string {
  return join(resolve(stateDir), COACH_DIRECTORY);
}

export function workerStatePath(directory: string): string {
  return join(directory, "worker.json");
}

/**
 * One harness version's directory beside the legacy layout:
 * `<coachDir>/workers/<versionKey>/{worker.json,control}`.
 */
export function versionedWorkerDirectory(directory: string, version: string | null): string {
  return join(directory, WORKERS_DIRECTORY, workerVersionKey(version));
}

export function versionedControlDirectory(directory: string, version: string | null): string {
  return join(versionedWorkerDirectory(directory, version), "control");
}

/** Every version's worker directory under one coach directory. */
export function workerStateDirectories(directory: string): string[] {
  const root = join(directory, WORKERS_DIRECTORY);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The cycle lease: one Coach cycle at a time across every harness version.
 * Unlike the worker lock it is held only while a cycle runs, so a drained
 * worker's in-flight cycle finishes before the new worker claims the next one.
 */
export function cycleLockPath(directory: string): string {
  return join(directory, "cycle.lock");
}

export function settingsPath(directory: string): string {
  return join(directory, "settings.json");
}

export function controlDirectory(directory: string): string {
  return join(directory, "control");
}

/** The ledger: one entry per family plus the pending queue. */
export function ledgerPath(directory: string): string {
  return join(directory, "state.json");
}

export function lockPath(directory: string): string {
  return join(directory, "lock");
}

/** A version's own worker lock beside the legacy lock. */
export function versionedLockPath(directory: string, version: string | null): string {
  return versionLockPath(lockPath(directory), version);
}

export function runsDirectory(directory: string): string {
  return join(directory, "runs");
}

export function latestPath(directory: string): string {
  return join(directory, "latest.json");
}
