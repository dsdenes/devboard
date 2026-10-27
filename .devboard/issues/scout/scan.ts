import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GOAL_PROPOSALS_DIRECTORY } from "../../server/goal-proposal";
import { runIdentifier } from "../worker";
import {
  CATEGORIES,
  EXCLUDED_ROOTS,
  requestPath,
  scanDirectory,
  scansDirectory,
} from "./paths";
import { writeAtomic } from "./state";
import type { ScoutRecommendation } from "./recommendation";

/**
 * One scan's request: written before the prompt and read by the agent, so the
 * contract between the worker and `/scout-recommendations` is a file, not a
 * convention. The request names what to ignore and what is already known, so
 * the agent never proposes a staged item, an open issue, or a draft goal.
 */

export const SCAN_PROMPT = "/scout-recommendations";

export interface ScanRequest {
  version: 1;
  scanId: string;
  repository: string;
  repositoryPath: string;
  /** The slots the board has free; the agent returns at most this many. */
  missing: number;
  categories: string[];
  excludedRoots: string[];
  staged: Array<{ id: string; category: string; title: string }>;
  openIssueTitles: string[];
  draftGoalHeadings: string[];
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
  missing: number;
  staged: ScoutRecommendation[];
  openIssueTitles: string[];
  draftGoalHeadings: string[];
}): ScanRequest {
  return {
    version: 1,
    scanId: options.scan.scanId,
    repository: options.repository,
    repositoryPath: resolve(options.repoDir),
    missing: options.missing,
    categories: [...CATEGORIES],
    excludedRoots: [...EXCLUDED_ROOTS],
    staged: options.staged.map((item) => ({
      id: item.id,
      category: item.category,
      title: item.title,
    })),
    openIssueTitles: [...options.openIssueTitles],
    draftGoalHeadings: [...options.draftGoalHeadings],
    createdAt: options.scan.startedAt,
  };
}

export function writeRequest(directory: string, request: ScanRequest): string {
  const path = requestPath(directory);
  writeAtomic(path, `${JSON.stringify(request, null, 2)}\n`);
  return path;
}

export function promptFor(directory: string): string {
  return `${SCAN_PROMPT} ${directory}`;
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
