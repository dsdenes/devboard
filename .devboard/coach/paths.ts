import { join, resolve } from "node:path";

/**
 * Every file the Coach worker owns. One instance serves one repository state
 * directory, so the dashboard's `STATE_DIR` is the only anchor: the worker,
 * its settings, control channel, ledger, lock, and runs all live under
 * `<STATE_DIR>/coach/`.
 */

export const COACH_DIRECTORY = "coach";
export const WORKER_VERSION = 1;
export const LEDGER_VERSION = 3;
export const PROJECTION_VERSION = 1;

export function coachDirectory(stateDir: string): string {
  return join(resolve(stateDir), COACH_DIRECTORY);
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

/** The ledger: one entry per family plus the pending queue. */
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

/** The last successful forge projection the filing caps count. */
export function projectionPath(directory: string): string {
  return join(directory, "projection.json");
}
