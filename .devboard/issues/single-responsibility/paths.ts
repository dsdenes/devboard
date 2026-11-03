import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";
import { workerVersionKey } from "../lock";

/**
 * Every path one repository's Single Responsibility worker owns. State lives
 * beside the dashboard's other agent state, keyed by the repository path,
 * while the lock and cycle directories live inside the checkout: one
 * repository can have only one audit cycle, whichever dashboard is attached.
 */

export const SINGLE_RESPONSIBILITY_DIRECTORY = "single-responsibility";
export const STATE_VERSION = 1;
export const CYCLE_VERSION = 1;

/** The periodic forge read while the worker is started. */
export const SYNC_INTERVAL_MS = 60_000;
/** The rolling window the hourly cap counts inside. */
export const HOUR_MS = 60 * 60_000;
/** The default number of single-responsibility issues the agent may create per hour. */
export const DEFAULT_MAX_PER_HOUR = 10;
/** The default number of open single-responsibility issues that may exist. */
export const DEFAULT_MAX_PENDING = 5;
/** The default audit cadence, in minutes. */
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
 * The five violation categories the skill publishes. A finding belongs to
 * exactly one of them; a candidate outside them is dropped and recorded in
 * activity, never filed.
 */
export const SINGLE_RESPONSIBILITY_CATEGORIES = [
  "mixed-responsibilities",
  "divergent-change",
  "accidental-aggregation",
  "responsibility-leakage",
  "artificial-fragmentation",
] as const;

export type SingleResponsibilityCategory =
  (typeof SINGLE_RESPONSIBILITY_CATEGORIES)[number];

export const SINGLE_RESPONSIBILITY_LABEL = "single-responsibility";
export const LABEL_COLOR = "0e8a16";
export const LABEL_DESCRIPTION =
  "Single Responsibility violation proved against the project SRP skill";

/**
 * The one normative skill of every cycle, repository-relative. The skill is
 * installed by the harness into the host's `.omp/skills`, so the worker reads
 * the project copy the agent also reads.
 */
export const DEFAULT_SKILL_DIRECTORY = ".omp/skills/devboard-single-responsibility-principle";
export const SKILL_FILE = "SKILL.md";

export interface SingleResponsibilityConfig {
  /** The skill directory, repository-relative. */
  skillDir: string;
  /** The skill's own document, repository-relative. */
  skillDocument: string;
}

/** The fixed audit configuration, identical in every host that installs the harness. */
export function singleResponsibilityConfig(): SingleResponsibilityConfig {
  return {
    skillDir: DEFAULT_SKILL_DIRECTORY,
    skillDocument: `${DEFAULT_SKILL_DIRECTORY}/${SKILL_FILE}`,
  };
}

/** `<STATE_DIR>/single-responsibility`: every repository's state below one dashboard. */
export function singleResponsibilityRoot(stateDir: string): string {
  return join(stateDir, SINGLE_RESPONSIBILITY_DIRECTORY);
}

export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(singleResponsibilityRoot(stateDir), journalKey(resolve(repoDir)));
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

/**
 * `<REPO_DIR>/.devboard/.tmp/single-responsibility`, the checkout-anchored
 * working tree. A cycle's only writes live below it.
 */
export function workDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", SINGLE_RESPONSIBILITY_DIRECTORY);
}

/** The repository-anchored lock: one audit cycle per checkout. */
export function lockPath(repoDir: string): string {
  return join(workDirectory(repoDir), "lock");
}

export function cyclesDirectory(repoDir: string): string {
  return join(workDirectory(repoDir), "cycles");
}

/** The one checkout-wide lease for the cycle currently being audited. */
export function cycleClaimPath(repoDir: string): string {
  return join(workDirectory(repoDir), "cycle-claim");
}

export function cycleDirectory(repoDir: string, cycleId: string): string {
  return join(cyclesDirectory(repoDir), cycleId);
}

/** The request document naming the surface, the skill, and the caps. */
export function requestPath(directory: string): string {
  return join(directory, "request.json");
}
