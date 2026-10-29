import { join, resolve } from "node:path";

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
