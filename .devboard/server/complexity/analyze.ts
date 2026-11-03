/**
 * The complexity analyzer: discovers the harness's own application source,
 * measures every file, and aggregates the per-function and per-file values
 * into the project-level figures one snapshot records.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  halsteadVolume,
  maintainabilityIndex,
  measureSource,
  round,
  type FileMeasureSource,
  type FunctionMeasure,
} from "./measure";

export const COMPLEXITY_VERSION = 1;

/**
 * The application source the dashboard measures: its own server, client, and
 * shared modules, and the worker families that share this package.
 */
export const ANALYZED_DIRECTORIES = [
  "server",
  "client",
  "lib",
  "scripts",
  "extensions",
  "mcp",
  "issues",
  "watchdog",
  "release-train",
  "mcp-optimizer",
] as const;

/** Directories that hold build output or dependencies, never application source. */
const EXCLUDED_DIRECTORIES: Record<string, true> = {
  "node_modules": true,
  "dist": true,
  ".tmp": true,
  "public": true,
};

/** The extensions that hold application source. */
const SOURCE_EXTENSIONS: Record<string, true> = {
  ".ts": true,
  ".svelte": true,
  ".js": true,
  ".mjs": true,
};

/** A function whose cyclomatic complexity exceeds this is counted as complex. */
export const COMPLEXITY_THRESHOLD = 10;

/** One function's measurements, attributed to its file. */
export interface FunctionRow extends FunctionMeasure {
  /** Repository-relative path, e.g. `.devboard/server/app.ts`. */
  path: string;
}

/** One file's measurements in a snapshot. */
export interface FileMeasure {
  path: string;
  /** Non-blank, non-comment code lines. */
  loc: number;
  functions: number;
  /** Duplicated significant lines over this file's code lines, 0-1. */
  duplicatedLineRatio: number;
  /** Maintainability index clamped to 0-100. */
  maintainability: number;
}

/** The project-level figures one snapshot records. */
export interface ProjectMeasure {
  files: number;
  functions: number;
  loc: number;
  meanCyclomatic: number;
  maxCyclomatic: number;
  functionsOverThreshold: number;
  duplicatedLineRatio: number;
  meanMaintainability: number;
}

/** One recorded daily snapshot of the harness's own complexity. */
export interface ComplexitySnapshot {
  version: typeof COMPLEXITY_VERSION;
  /** The UTC calendar day the snapshot belongs to, `YYYY-MM-DD`. */
  date: string;
  /** When the snapshot was recorded, ISO-8601. */
  recordedAt: string;
  project: ProjectMeasure;
  files: FileMeasure[];
  functions: FunctionRow[];
}

/** What one analysis pass measured, before it is stamped with a date. */
export interface ComplexityAnalysis {
  project: ProjectMeasure;
  files: FileMeasure[];
  functions: FunctionRow[];
}

/** The UTC calendar day of an instant. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isSourceFile(name: string): boolean {
  if (name.endsWith(".test.ts") || name.includes(".test.")) return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return Object.hasOwn(SOURCE_EXTENSIONS, name.slice(dot));
}

/** Every measured file under one directory, depth-first and name-sorted. */
function collectSources(
  directory: string,
  root: string,
  sources: Array<{ path: string; measure: FileMeasureSource }>,
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // A directory the running package does not ship is simply not measured.
    return;
  }
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of ordered) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (Object.hasOwn(EXCLUDED_DIRECTORIES, entry.name)) continue;
      collectSources(path, root, sources);
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    sources.push({ path: path.slice(root.length + 1), measure: measureSource(text) });
  }
}

/**
 * Measures the harness at `root` and aggregates the result. The same unchanged
 * tree yields the same values: discovery is name-sorted and no measurement
 * reads a clock or the network.
 */
export function analyzeComplexity(root: string): ComplexityAnalysis {
  const harnessRoot = resolve(root);
  const sources: Array<{ path: string; measure: FileMeasureSource }> = [];
  for (const directory of ANALYZED_DIRECTORIES) {
    collectSources(join(harnessRoot, directory), harnessRoot, sources);
  }

  const occurrences = new Map<string, number>();
  for (const source of sources) {
    for (const [line, count] of source.measure.lines) {
      occurrences.set(line, (occurrences.get(line) ?? 0) + count);
    }
  }

  const files: FileMeasure[] = [];
  const functions: FunctionRow[] = [];
  let totalLoc = 0;
  let duplicatedLoc = 0;
  let complexityTotal = 0;
  let maxCyclomatic = 0;
  let complexFunctions = 0;
  let maintainabilityTotal = 0;

  for (const source of sources) {
    const path = `.devboard/${source.path}`;
    const measured = source.measure.functions;
    let complexitySum = 0;
    let deepest = 0;
    for (const entry of measured) {
      complexitySum += entry.cyclomatic;
      deepest = Math.max(deepest, entry.cyclomatic);
      if (entry.cyclomatic > COMPLEXITY_THRESHOLD) complexFunctions += 1;
      functions.push({ path, ...entry });
    }
    const meanComplexity = measured.length === 0 ? 1 : complexitySum / measured.length;
    let duplicated = 0;
    for (const [line, count] of source.measure.lines) {
      if ((occurrences.get(line) ?? 0) > 1) duplicated += count;
    }
    const maintainability = maintainabilityIndex(
      halsteadVolume(source.measure.halstead),
      meanComplexity,
      source.measure.loc,
    );
    files.push({
      path,
      loc: source.measure.loc,
      functions: measured.length,
      duplicatedLineRatio: round(source.measure.loc === 0 ? 0 : duplicated / source.measure.loc, 4),
      maintainability,
    });
    totalLoc += source.measure.loc;
    duplicatedLoc += duplicated;
    complexityTotal += complexitySum;
    maxCyclomatic = Math.max(maxCyclomatic, deepest);
    maintainabilityTotal += maintainability;
  }

  const project: ProjectMeasure = {
    files: files.length,
    functions: functions.length,
    loc: totalLoc,
    meanCyclomatic: round(functions.length === 0 ? 0 : complexityTotal / functions.length, 2),
    maxCyclomatic,
    functionsOverThreshold: complexFunctions,
    duplicatedLineRatio: round(totalLoc === 0 ? 0 : duplicatedLoc / totalLoc, 4),
    meanMaintainability: round(files.length === 0 ? 0 : maintainabilityTotal / files.length, 2),
  };

  // Directory order is a discovery detail; the snapshot orders its rows by
  // path so the page and the stored bytes are stable.
  files.sort((left, right) => left.path.localeCompare(right.path));
  functions.sort(
    (left, right) => left.path.localeCompare(right.path) || left.line - right.line,
  );

  return { project, files, functions };
}

/** The full snapshot for the UTC day of `now`. */
export function buildComplexitySnapshot(root: string, now: Date): ComplexitySnapshot {
  const analysis = analyzeComplexity(root);
  return {
    version: COMPLEXITY_VERSION,
    date: utcDate(now),
    recordedAt: now.toISOString(),
    ...analysis,
  };
}
