import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GOAL_PROPOSALS_DIRECTORY } from "../../server/goal-proposal";
import { runIdentifier } from "../worker";
import {
  CATEGORIES,
  EXCLUDED_ROOTS,
  HOUR_MS,
  SIGNIFICANCE_THRESHOLD,
  recommendationsPath,
  requestPath,
  scanDirectory,
  scansDirectory,
} from "./paths";
import { normalizeTitle } from "./recommendation";
import { writeAtomic, type ScoutLimits } from "./state";

/**
 * One scan's request: written before the prompt and read by the agent, so the
 * contract between the worker and `/scout-recommendations` is a file, not a
 * convention. The request names how many issues may be filed, what to ignore,
 * and which titles already exist, so the agent never restates a known finding.
 */

export const SCAN_PROMPT = "/scout-recommendations";

export interface ScanRequest {
  version: 2;
  scanId: string;
  repository: string;
  repositoryPath: string;
  /** How many significant findings this scan may turn into issues. */
  requested: number;
  categories: string[];
  excludedRoots: string[];
  /** Normalized titles of existing Auto Scout issues and open issues. */
  knownTitles: string[];
  draftGoalHeadings: string[];
  /** Findings below this score are not filed. */
  significanceThreshold: number;
  createdAt: string;
}

export interface CreatedScan {
  scanId: string;
  directory: string;
  startedAt: string;
}

/** A UTC timestamp name, made unique when two scans start in one millisecond. */
export function createScanDirectory(repoDir: string, now: Date): CreatedScan {
  const base = scansDirectory(repoDir);
  mkdirSync(base, { recursive: true });
  const stamp = runIdentifier(now);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const scanId = attempt === 0 ? stamp : `${stamp}-${attempt}`;
    const directory = scanDirectory(repoDir, scanId);
    try {
      mkdirSync(directory);
      return { scanId, directory, startedAt: now.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not create a scan directory under ${base}`);
}

export function buildRequest(options: {
  scan: CreatedScan;
  repository: string;
  repoDir: string;
  requested: number;
  knownTitles: string[];
  draftGoalHeadings: string[];
}): ScanRequest {
  return {
    version: 2,
    scanId: options.scan.scanId,
    repository: options.repository,
    repositoryPath: resolve(options.repoDir),
    requested: options.requested,
    categories: [...CATEGORIES],
    excludedRoots: [...EXCLUDED_ROOTS],
    knownTitles: [...options.knownTitles],
    draftGoalHeadings: [...options.draftGoalHeadings],
    significanceThreshold: SIGNIFICANCE_THRESHOLD,
    createdAt: options.scan.startedAt,
  };
}

export function writeRequest(directory: string, request: ScanRequest): string {
  const path = requestPath(directory);
  writeAtomic(path, `${JSON.stringify(request, null, 2)}\n`);
  return path;
}

/** One row the capacity and title helpers read from the persisted board. */
export interface ScanIssueFact {
  title: string;
  createdAt: string;
  state: string;
}

export interface ScanCapacity {
  /** How many issues this cycle may create. */
  batch: number;
  windowCount: number;
  openCount: number;
  hourlyRoom: number;
  pendingRoom: number;
  /** When zero capacity may become positive again. */
  blockedUntil: string | null;
}

/**
 * The effective batch: how many issues this cycle may create. The hourly
 * window counts every Auto Scout issue created inside it, in any state, so a
 * restart never forgets a filing. The worker and the dashboard's request
 * preview both call this, so the preview can never contradict the request.
 */
export function scanCapacity(options: {
  issues: readonly ScanIssueFact[];
  limits: ScoutLimits;
  now: Date;
  syncMs: number;
}): ScanCapacity {
  const windowStart = options.now.getTime() - HOUR_MS;
  let windowCount = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let openCount = 0;
  for (const issue of options.issues) {
    const createdAt = Date.parse(issue.createdAt);
    if (Number.isFinite(createdAt) && createdAt > windowStart) {
      windowCount += 1;
      if (createdAt < oldest) oldest = createdAt;
    }
    if (issue.state === "pending") openCount += 1;
  }
  const hourlyRoom =
    options.limits.maxPerHour === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.limits.maxPerHour - windowCount);
  const pendingRoom =
    options.limits.maxPending === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.limits.maxPending - openCount);
  const batch = Math.min(hourlyRoom, pendingRoom);
  let blockedUntil: string | null = null;
  if (batch === 0) {
    const candidates: number[] = [];
    if (pendingRoom === 0) candidates.push(options.now.getTime() + options.syncMs);
    if (hourlyRoom === 0 && Number.isFinite(oldest)) candidates.push(oldest + HOUR_MS);
    if (candidates.length === 0) candidates.push(options.now.getTime() + options.syncMs);
    blockedUntil = new Date(Math.min(...candidates)).toISOString();
  }
  return { batch, windowCount, openCount, hourlyRoom, pendingRoom, blockedUntil };
}

/**
 * Normalized titles the scan must not restate: Auto Scout issues in any state,
 * every open issue, and the draft goal headings. One implementation keeps every
 * scan's dedup identical.
 */
export function knownTitlesFor(
  issues: readonly { title: string }[],
  openTitles: readonly string[],
  draftGoalHeadings: readonly string[],
): string[] {
  const titles = new Set<string>();
  for (const issue of issues) titles.add(normalizeTitle(issue.title));
  for (const title of openTitles) titles.add(normalizeTitle(title));
  for (const heading of draftGoalHeadings) titles.add(normalizeTitle(heading));
  return [...titles].sort();
}

export function promptFor(directory: string): string {
  return `${SCAN_PROMPT} ${directory}`;
}

/**
 * The one correction turn a scan gets after its answer is rejected. It quotes
 * the rejection and restates the two output rules the model most often
 * misses, so a fixable mistake costs a turn instead of the whole finding.
 */
export function repairPrompt(directory: string, rejection: string): string {
  return [
    `Auto Scout rejected the scan answer at ${recommendationsPath(directory)}: ${rejection}`,
    "",
    `Rewrite ${recommendationsPath(directory)} so it satisfies the scan prompt's output ` +
      "contract, changing only what the rejection names.",
    `Every \`evidence[].path\` and every \`files\` entry is relative to the \`repositoryPath\` ` +
      `in ${requestPath(directory)}: a file nested under a directory keeps those leading ` +
      "segments in its path. Each cited path must name an existing regular file and each " +
      "line span must lie inside that file.",
    "Never modify the repository and write nothing else. Finish in this turn.",
  ].join("\n");
}

/** The `# heading` of every draft under `<REPO_DIR>/.devboard/goal-proposals/`. */
export function readDraftGoalHeadings(repoDir: string): string[] {
  const directory = join(resolve(repoDir), GOAL_PROPOSALS_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const headings: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("# ")) headings.push(trimmed.slice(2).trim());
      break;
    }
  }
  return headings;
}
