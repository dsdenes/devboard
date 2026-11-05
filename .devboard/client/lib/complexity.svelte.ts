import { connection } from "./connection.svelte";

/** One project-level measurement as the complexity page renders it. */
export interface ComplexityProjectRow {
  files: number;
  functions: number;
  loc: number;
  meanCyclomatic: number;
  maxCyclomatic: number;
  functionsOverThreshold: number;
  duplicatedLineRatio: number;
  meanMaintainability: number;
}

/** One recorded date in the complexity time series. */
export interface ComplexityPoint {
  date: string;
  recordedAt: string;
  project: ComplexityProjectRow;
}

/** One analyzed file in the newest snapshot. */
export interface ComplexityFileRow {
  path: string;
  loc: number;
  functions: number;
  duplicatedLineRatio: number;
  maintainability: number;
}

/** The newest snapshot with its per-file detail. */
export interface ComplexityLatest {
  date: string;
  recordedAt: string;
  project: ComplexityProjectRow;
  files: ComplexityFileRow[];
}

/** Every recorded date plus the newest snapshot's detail. */
export interface ComplexityView {
  points: ComplexityPoint[];
  latest: ComplexityLatest | null;
}

/** No recorded snapshot yet. */
export const EMPTY_COMPLEXITY_VIEW: ComplexityView = { points: [], latest: null };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** One project-level row, or `undefined` when any figure is malformed. */
function projectRow(value: unknown): ComplexityProjectRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const {
    files,
    functions,
    loc,
    meanCyclomatic,
    maxCyclomatic,
    functionsOverThreshold,
    duplicatedLineRatio,
    meanMaintainability,
  } = value as Record<string, unknown>;
  if (
    !isCount(files) ||
    !isCount(functions) ||
    !isCount(loc) ||
    !isCount(meanCyclomatic) ||
    !isCount(maxCyclomatic) ||
    !isCount(functionsOverThreshold) ||
    typeof duplicatedLineRatio !== "number" ||
    typeof meanMaintainability !== "number"
  ) {
    return undefined;
  }
  return {
    files,
    functions,
    loc,
    meanCyclomatic,
    maxCyclomatic,
    functionsOverThreshold,
    duplicatedLineRatio,
    meanMaintainability,
  };
}

/** One analyzed file, or `undefined` when any figure is malformed. */
function fileRow(value: unknown): ComplexityFileRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string" || row.path.length === 0) return undefined;
  if (!isCount(row.loc) || !isCount(row.functions)) return undefined;
  if (typeof row.duplicatedLineRatio !== "number" || typeof row.maintainability !== "number") {
    return undefined;
  }
  return {
    path: row.path,
    loc: row.loc,
    functions: row.functions,
    duplicatedLineRatio: row.duplicatedLineRatio,
    maintainability: row.maintainability,
  };
}

/**
 * The complexity frame the server pushes: one point per recorded date, oldest
 * first, and the newest snapshot's per-file detail. A malformed point or file
 * row is dropped rather than charted with a value the server never measured.
 */
export function complexityView(value: unknown): ComplexityView {
  if (typeof value !== "object" || value === null) return EMPTY_COMPLEXITY_VIEW;
  const frame = value as Record<string, unknown>;
  const points: ComplexityPoint[] = [];
  if (Array.isArray(frame.snapshots)) {
    for (const entry of frame.snapshots) {
      if (typeof entry !== "object" || entry === null) continue;
      const point = entry as Record<string, unknown>;
      if (typeof point.date !== "string" || typeof point.recordedAt !== "string") continue;
      const project = projectRow(point.project);
      if (project === undefined) continue;
      points.push({ date: point.date, recordedAt: point.recordedAt, project });
    }
  }
  const latestEntry = frame.latest;
  let latest: ComplexityLatest | null = null;
  if (typeof latestEntry === "object" && latestEntry !== null) {
    const record = latestEntry as Record<string, unknown>;
    const project = projectRow(record.project);
    if (
      project !== undefined &&
      typeof record.date === "string" &&
      typeof record.recordedAt === "string"
    ) {
      const files: ComplexityFileRow[] = [];
      if (Array.isArray(record.files)) {
        for (const entry of record.files) {
          const row = fileRow(entry);
          if (row !== undefined) files.push(row);
        }
      }
      latest = { date: record.date, recordedAt: record.recordedAt, project, files };
    }
  }
  return { points, latest };
}

/**
 * Holds the project complexity history the dashboard server computes daily.
 * The page asks once per connection and renders the reply whenever a new
 * snapshot frame arrives.
 */
export class ComplexityStore {
  complexity = $state<ComplexityView>(EMPTY_COMPLEXITY_VIEW);
  complexityLoaded = $state(false);

  requestComplexity(): void {
    connection.send({ type: "getComplexity" });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type !== "complexityState") return;
    this.complexity = complexityView(message.state);
    this.complexityLoaded = true;
  }
}

export const complexity = new ComplexityStore();
