/**
 * Snapshot persistence for the complexity dashboard. One file per UTC
 * calendar day lives under the dashboard's own state directory; a file whose
 * bytes do not validate is skipped, never rewritten, and never replaced by a
 * second snapshot for a day that already has one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalKey } from "../journal";
import { writeFileAtomically } from "../state";
import {
  COMPLEXITY_VERSION,
  type ComplexitySnapshot,
  type FileMeasure,
  type FunctionRow,
  type ProjectMeasure,
} from "./analyze";

/** `<STATE_DIR>/complexity`, the one root this feature writes under. */
export function complexityRoot(stateDir: string): string {
  return join(stateDir, "complexity");
}

/** This checkout's own snapshot directory, keyed like every other state file. */
export function complexityDirectory(stateDir: string, repoDir: string): string {
  return join(complexityRoot(stateDir), journalKey(resolve(repoDir)));
}

/** The one file a UTC day owns. */
export function snapshotFile(directory: string, date: string): string {
  return join(directory, `${date}.json`);
}

const SNAPSHOT_NAME = /^(\d{4}-\d{2}-\d{2})\.json$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProject(value: unknown): value is ProjectMeasure {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    isCount(project.files) &&
    isCount(project.functions) &&
    isCount(project.loc) &&
    isCount(project.meanCyclomatic) &&
    isCount(project.maxCyclomatic) &&
    isCount(project.functionsOverThreshold) &&
    typeof project.duplicatedLineRatio === "number" &&
    project.duplicatedLineRatio >= 0 &&
    project.duplicatedLineRatio <= 1 &&
    typeof project.meanMaintainability === "number" &&
    project.meanMaintainability >= 0 &&
    project.meanMaintainability <= 100
  );
}

function isFileRow(value: unknown): value is FileMeasure {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.path === "string" &&
    row.path.length > 0 &&
    isCount(row.loc) &&
    isCount(row.functions) &&
    typeof row.duplicatedLineRatio === "number" &&
    row.duplicatedLineRatio >= 0 &&
    row.duplicatedLineRatio <= 1 &&
    typeof row.maintainability === "number" &&
    row.maintainability >= 0 &&
    row.maintainability <= 100
  );
}

function isFunctionRow(value: unknown): value is FunctionRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.path === "string" &&
    typeof row.name === "string" &&
    isCount(row.line) &&
    isCount(row.lines) &&
    isCount(row.cyclomatic) &&
    isCount(row.nesting) &&
    isCount(row.parameters)
  );
}

/**
 * One snapshot from its stored bytes, or `undefined` when any part is
 * malformed. A stored snapshot is read whole or not at all: a partially valid
 * one would report figures the analyzer never produced.
 */
export function parseSnapshot(value: unknown): ComplexitySnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== COMPLEXITY_VERSION) return undefined;
  if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    return undefined;
  }
  if (typeof record.recordedAt !== "string" || record.recordedAt.length === 0) return undefined;
  if (!isProject(record.project)) return undefined;
  if (!Array.isArray(record.files) || !record.files.every(isFileRow)) return undefined;
  if (!Array.isArray(record.functions) || !record.functions.every(isFunctionRow)) return undefined;
  return {
    version: COMPLEXITY_VERSION,
    date: record.date,
    recordedAt: record.recordedAt,
    project: record.project,
    files: record.files,
    functions: record.functions,
  };
}

/**
 * Every readable snapshot in the directory, oldest first. A missing directory
 * is an empty history; an unreadable or malformed file is skipped so one
 * damaged day never hides the days around it.
 */
export function readSnapshots(directory: string): ComplexitySnapshot[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const snapshots: ComplexitySnapshot[] = [];
  for (const name of names.sort()) {
    const match = SNAPSHOT_NAME.exec(name);
    if (match === null) continue;
    const date = match[1] ?? "";
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const snapshot = parseSnapshot(parsed);
    if (snapshot === undefined || snapshot.date !== date) continue;
    snapshots.push(snapshot);
  }
  return snapshots.sort((left, right) => left.date.localeCompare(right.date));
}

/** Writes one day's snapshot atomically; the whole file replaces the last one. */
export async function writeSnapshot(
  directory: string,
  snapshot: ComplexitySnapshot,
): Promise<void> {
  await writeFileAtomically(snapshotFile(directory, snapshot.date), `${JSON.stringify(snapshot)}\n`);
}

/** The payload one snapshot contributes to every connected page. */
export interface SnapshotSummary {
  date: string;
  recordedAt: string;
  project: ProjectMeasure;
}

/** The frame the server pushes: every recorded date, plus the newest detail. */
export interface ComplexityFrame {
  snapshots: SnapshotSummary[];
  latest: ComplexitySnapshot | null;
}

/** The page payload for a history ending at `latest`. */
export function complexityFrame(
  snapshots: readonly ComplexitySnapshot[],
  latest: ComplexitySnapshot | null,
): ComplexityFrame {
  return {
    snapshots: snapshots.map((snapshot) => ({
      date: snapshot.date,
      recordedAt: snapshot.recordedAt,
      project: snapshot.project,
    })),
    latest,
  };
}
