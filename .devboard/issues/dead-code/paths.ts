import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";
import { workerVersionKey } from "../lock";

/**
 * Every path one repository's Dead Code worker owns. State lives beside the
 * dashboard's other agent state, keyed by the repository path, while the lock
 * and cycles live inside the checkout: one repository can have only one Dead
 * Code cycle, whichever dashboard is attached.
 */

export const DEAD_CODE_DIRECTORY = "dead-code";
export const STATE_VERSION = 1;
export const CYCLE_VERSION = 1;

/** The periodic forge read while the worker is started. */
export const SYNC_INTERVAL_MS = 60_000;
/** The rolling window the hourly cap counts inside. */
export const HOUR_MS = 60 * 60_000;
/** The default number of dead-code issues the agent may create per rolling hour. */
export const DEFAULT_MAX_PER_HOUR = 10;
/** The default number of open dead-code issues that may exist. */
export const DEFAULT_MAX_PENDING = 5;
/** The default detection cadence, in minutes. */
export const DEFAULT_INTERVAL_MINUTES = 60;
export const CADENCE_MIN_MINUTES = 1;
export const CADENCE_MAX_MINUTES = 1440;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

/** One cycle may file no more than this many issues, whatever the caps allow. */
export const CYCLE_ISSUE_LIMIT = 100;
/** A finding title may not exceed this many characters. */
export const TITLE_MAX = 200;

/**
 * The five dead-code categories. A finding outside them is dropped and
 * recorded in activity; it is never filed.
 */
export const DEAD_CODE_CATEGORIES = [
  "unreferenced-file",
  "unreferenced-symbol",
  "unreachable-branch",
  "unused-dependency",
  "unmatched-selector",
] as const;

export type DeadCodeCategory = (typeof DEAD_CODE_CATEGORIES)[number];

export const DEAD_CODE_LABEL = "dead-code";
export const LABEL_COLOR = "8250df";
export const LABEL_DESCRIPTION = "Dead code proved removable by the Dead Code agent";

/** `<STATE_DIR>/dead-code`: every repository's state below one dashboard. */
export function deadCodeRoot(stateDir: string): string {
  return join(stateDir, DEAD_CODE_DIRECTORY);
}

export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(deadCodeRoot(stateDir), journalKey(resolve(repoDir)));
}

export function statePath(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "state.json");
}

/** One worker version's state, beside the legacy state older harnesses write. */
export function versionedStatePath(
  stateDir: string,
  repoDir: string,
  version: string | null,
): string {
  return join(
    repoStateDirectory(stateDir, repoDir),
    "workers",
    workerVersionKey(version),
    "state.json",
  );
}

export function versionedControlDirectory(
  stateDir: string,
  repoDir: string,
  version: string | null,
): string {
  return join(
    repoStateDirectory(stateDir, repoDir),
    "workers",
    workerVersionKey(version),
    "control",
  );
}

/** Every versioned worker directory under one repository state. */
export function workerStateDirectories(stateDir: string, repoDir: string): string[] {
  const root = join(repoStateDirectory(stateDir, repoDir), "workers");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export function settingsPath(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "settings.json");
}

export function controlDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "control");
}

/** `<REPO_DIR>/.devboard/.tmp/dead-code`, the checkout-anchored working tree. */
export function workDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", DEAD_CODE_DIRECTORY);
}

/** The repository-anchored lock: one dead-code cycle per checkout. */
export function lockPath(repoDir: string): string {
  return join(workDirectory(repoDir), "lock");
}

export function cyclesDirectory(repoDir: string): string {
  return join(workDirectory(repoDir), "cycles");
}

/** The one checkout-wide lease for the cycle currently being detected. */
export function cycleClaimPath(repoDir: string): string {
  return join(workDirectory(repoDir), "cycle-claim");
}

export function cycleDirectory(repoDir: string, cycleId: string): string {
  return join(cyclesDirectory(repoDir), cycleId);
}

/** The request document naming the entry point, caps, and cycle time. */
export function requestPath(directory: string): string {
  return join(directory, "request.json");
}
