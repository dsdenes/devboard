import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  excludedRoots,
  pickEntryPoint,
  type EntryPoint,
  type EntryPointSurface,
} from "../../lib/entry-point";
import { runIdentifier } from "../worker";
import {
  CATEGORIES,
  HOUR_MS,
  SIGNIFICANCE_THRESHOLD,
  requestPath,
  scanDirectory,
  scansDirectory,
} from "./paths";
import { writeAtomic, type ScoutLimits } from "./state";

export { readDraftGoalHeadings } from "../../lib/draft-goals";

/**
 * One scan's request: written before the prompt and read by the agent, so the
 * contract between the worker and `/scout-recommendations` is a file, not a
 * convention. The request names how many issues may be filed, what to ignore,
 * and which titles already exist, so the agent never restates a known finding.
 */

export const SCAN_PROMPT = "/scout-recommendations";

export interface ScanRequest {
  version: 4;
  scanId: string;
  repository: string;
  repositoryPath: string;
  /** How many significant findings this scan may turn into issues. */
  requested: number;
  /** The surface and seeded entry point every crawl starts from. */
  surface: EntryPointSurface;
  seed: string;
  entryPoint: { path: string; line: number };
  categories: string[];
  excludedRoots: string[];
  /** Every draft-goal heading the scan must not restate. */
  draftGoalHeadings: string[];
  /** Findings below this score are not filed. */
  significanceThreshold: number;
  /** Configured rolling-hour cap, or null when unlimited. */
  maxPerHour: number | null;
  /** Configured open-issue cap, or null when unlimited. */
  maxPending: number | null;
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
  draftGoalHeadings: string[];
  maxPerHour: number | null;
  maxPending: number | null;
  environment?: Record<string, string | undefined>;
  seed?: string;
}): ScanRequest {
  const pick: EntryPoint = pickEntryPoint({
    repoDir: options.repoDir,
    surface: "scout",
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return {
    version: 4,
    scanId: options.scan.scanId,
    repository: options.repository,
    repositoryPath: resolve(options.repoDir),
    requested: options.requested,
    surface: pick.surface,
    seed: pick.seed,
    entryPoint: { path: pick.path, line: pick.line },
    categories: [...CATEGORIES],
    excludedRoots: excludedRoots(options.repoDir),
    draftGoalHeadings: [...options.draftGoalHeadings],
    significanceThreshold: SIGNIFICANCE_THRESHOLD,
    maxPerHour: options.maxPerHour,
    maxPending: options.maxPending,
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
 * The one turn's prompt. The agent surveys the repository and files its own
 * accepted recommendations through the MCP issue-creation tool; no answer file
 * is named and no correction turn exists.
 */
export function promptFor(directory: string): string {
  return `${SCAN_PROMPT} ${directory}`;
}

