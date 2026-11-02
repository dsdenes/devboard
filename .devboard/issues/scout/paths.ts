import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";
import { workerVersionKey } from "../lock";

/**
 * Every path one repository's scout worker owns. State lives under the
 * dashboard's `STATE_DIR`, keyed by the repository path exactly like the
 * dashboard journal and the issues worker, so two checkouts sharing one state
 * directory never read each other's state. The lock and the scan directories
 * deliberately live in the checkout: one repository can have only one scout,
 * whichever state directory a dashboard was configured with.
 */

export const SCOUT_DIRECTORY = "scout";
/** A repository's state directory is named by its 24-hex journal key. */
const REPO_STATE_DIRECTORY = /^[0-9a-f]{24}$/;
export function isRepoStateDirectoryName(name: string): boolean {
  return REPO_STATE_DIRECTORY.test(name);
}
export const STATE_VERSION = 2;
export const SCAN_VERSION = 2;
/**
 * A scan's agent phase ends after this long without a session update, and its
 * separately timed settle-and-file phase ends after this long in total. A
 * productive agent keeps resetting the first bound with any protocol traffic,
 * including the progress frames of a long tool call.
 */
export const SCAN_TIMEOUT_MS = 15 * 60_000;
/** The periodic GitHub read while the worker is started. */
export const SYNC_INTERVAL_MS = 60_000;
/** The rolling window the hourly cap counts inside. */
export const HOUR_MS = 60 * 60_000;
/** The default number of issues Auto Scout may create per rolling hour. */
export const DEFAULT_MAX_PER_HOUR = 10;
/** The default number of Auto Scout issues that may stay open. */
export const DEFAULT_MAX_PENDING = 5;
/** The default scan cadence, in minutes. */
export const DEFAULT_INTERVAL_MINUTES = 1;
/** The cadence bounds every background agent shares. */
export const CADENCE_MIN_MINUTES = 1;
export const CADENCE_MAX_MINUTES = 1440;
/**
 * The largest batch one scan may request when a limit is empty. It bounds the
 * request document, not the filing: an empty cap removes the rolling-hour and
 * open-issue constraints, and this is only the most findings a single prompt
 * asks the agent to return.
 */
export const UNLIMITED_SCAN_BATCH = 100;
/** Both limits accept an integer from this value through `LIMIT_MAX`. */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
/** A finding earns an issue only at this significance or above. */
export const SIGNIFICANCE_THRESHOLD = 4;

export const CATEGORIES = [
  "clarity",
  "structure",
  "naming",
  "tests",
  "robustness",
  "correctness",
] as const;

export type ScoutCategory = (typeof CATEGORIES)[number];

/**
 * Trees the scan request tells the agent to ignore and evidence may never
 * point into: generated output, vendored packages, temporary state, and
 * per-task worktrees are not the repository under review.
 */
export const EXCLUDED_ROOTS = [
  ".git",
  "node_modules",
  "dist",
  ".worktree",
  ".tmp",
  ".devboard/.tmp",
];

/** `<STATE_DIR>/scout`: every repository's state below one dashboard. */
export function scoutRoot(stateDir: string): string {
  return join(stateDir, SCOUT_DIRECTORY);
}

/** `<STATE_DIR>/scout/<journalKey(REPO_DIR)>`. */
export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(scoutRoot(stateDir), journalKey(resolve(repoDir)));
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

/** The control directory one worker version consumes. */
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

/**
 * The limits the dashboard persists for a repository. It lives beside the
 * worker state so a save survives a page reload and a worker restart, and the
 * worker reads it at start rather than relying on a command it may have missed.
 */
export function settingsPath(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "settings.json");
}

/** Command files the dashboard writes and the worker consumes in order. */
export function controlDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "control");
}

/** `<REPO_DIR>/.devboard/.tmp/scout`: the checkout-anchored working tree. */
export function workDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", SCOUT_DIRECTORY);
}

/**
 * The repository-anchored lock: `<REPO_DIR>/.devboard/.tmp/scout/lock`.
 * A checkout cannot host two scouts even when their dashboards disagree about
 * the state directory.
 */
export function lockPath(repoDir: string): string {
  return join(workDirectory(repoDir), "lock");
}

/** `<REPO_DIR>/.devboard/.tmp/scout/scans`: one directory per scan. */
export function scansDirectory(repoDir: string): string {
  return join(workDirectory(repoDir), "scans");
}

export function scanDirectory(repoDir: string, scanId: string): string {
  return join(scansDirectory(repoDir), scanId);
}

export function requestPath(directory: string): string {
  return join(directory, "request.json");
}

export function scanFilePath(directory: string): string {
  return join(directory, "scan.json");
}
