import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";

/**
 * Every path one repository's scout worker owns. State lives under the
 * dashboard's `STATE_DIR`, keyed by the repository path exactly like the
 * dashboard journal and the issues worker, so two checkouts sharing one state
 * directory never read each other's boards. The lock and the scan directories
 * deliberately live in the checkout: one repository can have only one scout,
 * whichever state directory a dashboard was configured with.
 */

export const SCOUT_DIRECTORY = "scout";
export const STATE_VERSION = 1;
export const SCAN_VERSION = 1;
/** The staging board never holds more than this many recommendations. */
export const MAX_STAGED = 9;
export const DECISION_LIMIT = 200;
/** A scan that runs longer than this is closed and recorded as failed. */
export const SCAN_TIMEOUT_MS = 15 * 60_000;
/** The default wait before a shortfall or a failure schedules another scan. */
export const RETRY_MS = 10 * 60_000;

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

/** `<STATE_DIR>/scout`: every repository's board below one dashboard. */
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

export function recommendationsPath(directory: string): string {
  return join(directory, "recommendations.json");
}

export function scanFilePath(directory: string): string {
  return join(directory, "scan.json");
}

/** Scratch directory for issue bodies the worker hands to `gh`. */
export function issueBodyDirectory(repoDir: string): string {
  return join(workDirectory(repoDir), "issue-bodies");
}
