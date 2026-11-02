import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../../server/journal";
import { workerVersionKey } from "../lock";

/**
 * Every path one repository's Design System worker owns. State lives beside
 * the dashboard's other agent state, keyed by the repository path, while the
 * lock, cycles, and per-cycle worktrees live inside the checkout: one
 * repository can have only one design cycle, whichever dashboard is attached.
 */

export const DESIGN_DIRECTORY = "design";
export const STATE_VERSION = 1;
export const CYCLE_VERSION = 1;

/** The periodic forge read while the worker is started. */
export const SYNC_INTERVAL_MS = 60_000;
/** The rolling window the hourly cap counts inside. */
export const HOUR_MS = 60 * 60_000;
/** The default number of design issues the agent may create per rolling hour. */
export const DEFAULT_MAX_PER_HOUR = 10;
/** The default number of open design issues that may exist. */
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
 * The six design-system categories. A finding outside them is dropped and
 * recorded in activity; it is never filed.
 */
export const DESIGN_CATEGORIES = [
  "color",
  "typography",
  "spacing",
  "wording",
  "state",
  "placement",
] as const;

export type DesignCategory = (typeof DESIGN_CATEGORIES)[number];

export const DESIGN_LABEL = "design";
export const LABEL_COLOR = "1f6feb";
export const LABEL_DESCRIPTION = "Design system divergence from the documented interface";

/** The interface source file types a cycle audits, plus the root index. */
export const SOURCE_EXTENSIONS = [".svelte", ".css", ".ts"] as const;

export const DEFAULT_SOURCE_DIRECTORY = ".devboard/client";
export const DEFAULT_DESIGN_DOCUMENT = "DESIGN.md";
export const DEFAULT_TOKEN_DOCUMENT = "design/tokens.json";

/** The repository-relative audit target and its two normative documents. */
export interface DesignConfig {
  sourceDir: string;
  designDocument: string;
  tokenDocument: string;
}

function configured(
  environment: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = environment[key]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

/**
 * The audit configuration. Paths are repository-relative; a host that keeps
 * its design system elsewhere supplies them, while this repository's layout
 * is the default.
 */
export function designConfig(
  environment: Record<string, string | undefined> = process.env,
): DesignConfig {
  return {
    sourceDir: configured(environment, "DESIGN_SOURCE_DIR", DEFAULT_SOURCE_DIRECTORY),
    designDocument: configured(environment, "DESIGN_DOCUMENT", DEFAULT_DESIGN_DOCUMENT),
    tokenDocument: configured(environment, "DESIGN_TOKEN_DOCUMENT", DEFAULT_TOKEN_DOCUMENT),
  };
}

/** `<STATE_DIR>/design`: every repository's state below one dashboard. */
export function designRoot(stateDir: string): string {
  return join(stateDir, DESIGN_DIRECTORY);
}

export function repoStateDirectory(stateDir: string, repoDir: string): string {
  return join(designRoot(stateDir), journalKey(resolve(repoDir)));
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

export function settingsPath(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "settings.json");
}

export function controlDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), "control");
}

/** `<REPO_DIR>/.devboard/.tmp/design`, the checkout-anchored working tree. */
export function workDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", DESIGN_DIRECTORY);
}

/** The repository-anchored lock: one design cycle per checkout. */
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

/** The accepted audit answer the ACP peer writes. */
export function auditPath(directory: string): string {
  return join(directory, "audit.json");
}

/** The release request the MCP release tool records beside the draft. */
export function releaseRequestPath(directory: string): string {
  return join(directory, "release-request.json");
}

/** The request document naming the source, documents, and caps. */
export function requestPath(directory: string): string {
  return join(directory, "request.json");
}

/** The scratch copies the peer may edit; the worker decides whether to commit. */
export function draftDocumentPath(directory: string, document: string): string {
  return join(directory, "draft", document);
}

/** `<REPO_DIR>/.worktree`: the one worktree a documentation release uses. */
export function worktreesRoot(repoDir: string): string {
  return join(resolve(repoDir), ".worktree");
}

export function cycleBranch(cycleId: string): string {
  return `design/${cycleId}`;
}
