import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../server/journal";
import { workerVersionKey } from "./lock";

/**
 * Every path one repository's issues worker owns. State lives under the
 * dashboard's `STATE_DIR`, keyed by the repository path exactly like the
 * dashboard journal, so two checkouts sharing one state directory never read
 * each other's records. The lock deliberately lives in the checkout instead:
 * one repository can have only one worker, whichever state directory a
 * dashboard was configured with.
 */

export const ISSUES_DIRECTORY = "issues";
export const STATE_VERSION = 2;
export const LEDGER_VERSION = 1;
export const RUN_HISTORY_LIMIT = 50;
export const ACTIVITY_MAX_ENTRIES = 1000;
export const ACTIVITY_MAX_BYTES = 1024 * 1024;
export const ACTIVITY_TRIMMED_MARKER = "Earlier activity was trimmed.";

/** `<STATE_DIR>/issues`: every repository's records below one dashboard. */
export function issuesRoot(stateDir: string): string {
  return join(stateDir, ISSUES_DIRECTORY);
}

/** `<STATE_DIR>/issues/<journalKey(repoDir)>`. */
export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(issuesRoot(stateDir), journalKey(resolve(repoDir)));
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
  return join(repoStateDirectory(stateDir, repoDir), "workers", workerVersionKey(version), "state.json");
}

export function versionedControlDirectory(
  stateDir: string,
  repoDir: string,
  version: string | null,
): string {
  return join(repoStateDirectory(stateDir, repoDir), "workers", workerVersionKey(version), "control");
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

export function ledgerPath(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "ledger.json");
}

export function runsDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "runs");
}

export function runDirectory(stateDir: string, repoDir: string, runId: string): string {
  return join(runsDirectory(stateDir, repoDir), runId);
}

/** Command files the dashboard writes and the worker consumes in order. */
export function controlDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "control");
}

/**
 * The repository-anchored lock: `<REPO_DIR>/.devboard/.tmp/issues/lock`.
 * A checkout cannot host two workers even when their dashboards disagree
 * about the state directory.
 */
export function lockPath(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", ISSUES_DIRECTORY, "lock");
}

/** A version's own lock beside the legacy lock a pre-mechanism worker holds. */
export function versionedLockPath(repoDir: string, version: string | null): string {
  return `${lockPath(repoDir)}.${workerVersionKey(version)}`;
}

/** The removed systemd orchestrator's records, read only for migration. */
export function legacyDirectory(stateDir: string): string {
  return join(stateDir, "orchestrator");
}

export function legacyStatePath(stateDir: string): string {
  return join(legacyDirectory(stateDir), "state.json");
}

export function legacyLedgerPath(stateDir: string): string {
  return join(legacyDirectory(stateDir), "ledger.json");
}

export function legacyLockPath(stateDir: string): string {
  return join(legacyDirectory(stateDir), "lock");
}
