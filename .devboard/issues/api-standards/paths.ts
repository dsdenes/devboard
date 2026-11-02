import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";
import { workerVersionKey } from "../lock";

/**
 * Every path one repository's API Standards worker owns. State lives beside
 * the dashboard's other agent state, keyed by the repository path, while the
 * lock and cycle directories live inside the checkout: one repository can have
 * only one audit cycle, whichever dashboard is attached.
 */

export const API_STANDARDS_DIRECTORY = "api-standards";
export const STATE_VERSION = 1;
export const CYCLE_VERSION = 1;

/** The periodic forge read while the worker is started. */
export const SYNC_INTERVAL_MS = 60_000;
/** The rolling window the hourly cap counts inside. */
export const HOUR_MS = 60 * 60_000;
/** The default number of api-standards issues the agent may create per hour. */
export const DEFAULT_MAX_PER_HOUR = 10;
/** The default number of open api-standards issues that may exist. */
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

export const API_STANDARDS_LABEL = "api-standards";
export const LABEL_COLOR = "0e8a16";
export const LABEL_DESCRIPTION = "HTTP API deviation from the project REST standard";

/** The REST chapters a finding cites; the skill's reference groups its rows by them. */
export const RULE_LEVELS = ["MUST", "SHOULD", "MAY"] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

/** The documented shape of one reference rule row. */
export interface RestRule {
  /** The published numeric identifier, as text. */
  id: string;
  level: RuleLevel;
  /** The guideline chapter heading the row sits under. */
  chapter: string;
  /** The skill's directive, verbatim. */
  directive: string;
}

/** The repository-relative audit target and its two normative skill files. */
export interface ApiStandardsConfig {
  /** The API source directory, repository-relative. */
  sourceDir: string;
  /** The skill directory, repository-relative. */
  skillDir: string;
  /** The skill's own document, repository-relative. */
  skillDocument: string;
  /** The rule table, repository-relative. */
  rulesDocument: string;
}

export const DEFAULT_API_SOURCE_DIRECTORY = ".devboard/server";
export const DEFAULT_SKILL_DIRECTORY = ".omp/skills/devboard-restful-api-implementation";
export const SKILL_FILE = "SKILL.md";
export const RULES_FILE = "references/zalando-rest-rules.md";

/**
 * The fixed audit configuration. The API source and the REST skill sit at the
 * same repository-relative paths in every host; keeping them as constants is
 * what makes the surface portable, and no environment variable is added.
 */
export function apiStandardsConfig(): ApiStandardsConfig {
  return {
    sourceDir: DEFAULT_API_SOURCE_DIRECTORY,
    skillDir: DEFAULT_SKILL_DIRECTORY,
    skillDocument: `${DEFAULT_SKILL_DIRECTORY}/${SKILL_FILE}`,
    rulesDocument: `${DEFAULT_SKILL_DIRECTORY}/${RULES_FILE}`,
  };
}

/** `<STATE_DIR>/api-standards`: every repository's state below one dashboard. */
export function apiStandardsRoot(stateDir: string): string {
  return join(stateDir, API_STANDARDS_DIRECTORY);
}

export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(apiStandardsRoot(stateDir), journalKey(resolve(repoDir)));
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

/** `<REPO_DIR>/.devboard/.tmp/api-standards`, the checkout-anchored working tree. */
export function workDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", API_STANDARDS_DIRECTORY);
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

/** The request document naming the surface, the rules, and the caps. */
export function requestPath(directory: string): string {
  return join(directory, "request.json");
}

/** The answer the peer writes: one decision per candidate finding. */
export function findingsPath(directory: string): string {
  return join(directory, "findings.json");
}

/** The snapshot of the audited surface and the normative skill. */
export function inputPath(directory: string): string {
  return join(directory, "input.json");
}
