import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { versionLockPath, workerVersionKey } from "../issues/lock";

/**
 * Every file the Release Train family owns. The dashboard's `STATE_DIR` is the
 * only anchor: the shared release history, settings, run lock, and each
 * version's worker record and control channel live under
 * `<STATE_DIR>/release-train/`, beside the other families. Runs, their
 * requests, results, and activity live below `runs/<id>/`, so a dashboard
 * restart and a harness update leave every file readable.
 */

export const RELEASE_TRAIN_DIRECTORY = "release-train";
export const WORKERS_DIRECTORY = "workers";
export const RUNS_DIRECTORY = "runs";
export const STATE_VERSION = 1;
export const WORKER_VERSION = 1;
export const RUN_VERSION = 1;

export function releaseTrainDirectory(stateDir: string): string {
  return join(resolve(stateDir), RELEASE_TRAIN_DIRECTORY);
}

export function statePath(directory: string): string {
  return join(directory, "state.json");
}

export function settingsPath(directory: string): string {
  return join(directory, "settings.json");
}

/** The shared worker lock; each version gets its own beside it. */
export function lockPath(directory: string): string {
  return join(directory, "lock");
}

export function versionedLockPath(directory: string, version: string | null): string {
  return versionLockPath(lockPath(directory), version);
}

/** One version's worker record and control channel. */
export function versionedWorkerDirectory(directory: string, version: string | null): string {
  return join(directory, WORKERS_DIRECTORY, workerVersionKey(version));
}

export function versionedWorkerStatePath(directory: string, version: string | null): string {
  return join(versionedWorkerDirectory(directory, version), "worker.json");
}

export function versionedControlDirectory(directory: string, version: string | null): string {
  return join(versionedWorkerDirectory(directory, version), "control");
}

/** Every version's worker directory under one release-train directory. */
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

/** One lease for the single run the family may execute at a time. */
export function runLockPath(directory: string): string {
  return join(directory, "run.lock");
}

export function runsDirectory(directory: string): string {
  return join(directory, RUNS_DIRECTORY);
}

export function runDirectory(directory: string, id: string): string {
  return join(runsDirectory(directory), id);
}

/** The range, target, version, and commits the agent is handed. */
export function requestPath(directory: string, id: string): string {
  return join(runDirectory(directory, id), "request.json");
}

export function activityPath(directory: string, id: string): string {
  return join(runDirectory(directory, id), "activity.json");
}

/** The agent's optional outcome document; the worker verifies it itself. */
export function resultPath(directory: string, id: string): string {
  return join(runDirectory(directory, id), "result.json");
}
