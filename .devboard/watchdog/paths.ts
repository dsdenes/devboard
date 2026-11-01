import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { versionLockPath, workerVersionKey } from "../issues/lock";

/**
 * The watchdog is one machine-level instance per host root. Its runtime files
 * are anchored to the root, not to a dashboard's STATE_DIR, so every dashboard
 * on the root reads the same worker, settings, ledger, runs, and projection.
 */
export const WATCHDOG_DIRECTORY = "watchdog";
export const WORKER_VERSION = 1;
export const PROJECTION_VERSION = 1;

export function watchdogDirectory(root: string): string {
  return join(resolve(root), ".devboard", ".tmp", WATCHDOG_DIRECTORY);
}

export function workerStatePath(directory: string): string {
  return join(directory, "worker.json");
}

/** The directory holding one worker directory per harness version. */
export function workersDirectory(directory: string): string {
  return join(directory, "workers");
}

/** One worker version's state directory, beside the legacy state older harnesses write. */
export function versionedWorkerDirectory(directory: string, version: string | null): string {
  return join(workersDirectory(directory), workerVersionKey(version));
}

export function versionedWorkerStatePath(directory: string, version: string | null): string {
  return join(versionedWorkerDirectory(directory, version), "worker.json");
}

export function versionedControlDirectory(directory: string, version: string | null): string {
  return join(versionedWorkerDirectory(directory, version), "control");
}

/** Every versioned worker directory under one watchdog directory. */
export function workerStateDirectories(directory: string): string[] {
  const root = workersDirectory(directory);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** A version's own lock beside the legacy lock a pre-mechanism worker holds. */
export function versionedLockPath(directory: string, version: string | null): string {
  return versionLockPath(lockPath(directory), version);
}

/** The one-family lease that serialises watchdog cycles across versions. */
export function cycleClaimPath(directory: string): string {
  return join(directory, "cycle-claim.json");
}

export function settingsPath(directory: string): string {
  return join(directory, "settings.json");
}

export function controlDirectory(directory: string): string {
  return join(directory, "control");
}

export function ledgerPath(directory: string): string {
  return join(directory, "state.json");
}

export function lockPath(directory: string): string {
  return join(directory, "lock");
}

export function runsDirectory(directory: string): string {
  return join(directory, "runs");
}

export function latestPath(directory: string): string {
  return join(directory, "latest.json");
}

export function projectionPath(directory: string): string {
  return join(directory, "projection.json");
}
