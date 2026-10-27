import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ISSUES_DIRECTORY } from "../issues/paths";
import { JOURNAL_RETENTION_MS } from "../server/journal";

/**
 * Age-based retention for everything a devboard state directory accumulates.
 * The journal keeps its own rule in `server/journal.ts`; this module sweeps the
 * rest of `.tmp`: run directories, loop logs, legacy dashboard files, and
 * verification scratch. Nothing here decides what a dashboard should keep.
 */

/** The one-week threshold; the journal uses the same number. */
export const CLEANUP_RETENTION_MS = JOURNAL_RETENTION_MS;

export type CleanupSource = "canonical" | "sibling" | "instance";

export interface CoveredStateDir {
  stateDir: string;
  source: CleanupSource;
}

export interface CleanupCandidate {
  path: string;
  bytes: number;
  kind: "file" | "symlink" | "directory";
}

export interface CleanupRootReport {
  stateDir: string;
  source: CleanupSource;
  /** Everything eligible under this directory, whether or not it was removed. */
  candidates: CleanupCandidate[];
  /** What the run removed; empty in a dry run. */
  removed: CleanupCandidate[];
  /** Bytes removed, or bytes a dry run would remove. */
  bytes: number;
  files: number;
  directories: number;
  errors: string[];
}

export interface CleanupReport {
  now: string;
  cutoff: string;
  dryRun: boolean;
  roots: CleanupRootReport[];
}

export interface CleanupInstance {
  stateDir?: string;
  journal: string;
}

export interface CleanupRunOptions {
  root: string;
  now?: Date;
  dryRun?: boolean;
  instances?: CleanupInstance[];
  /** Test seam: replace discovery outright. */
  covered?: CoveredStateDir[];
  /** The watchdog run directory of the cycle performing the sweep. */
  watchdogRunDir?: string;
}

function stateDirectory(instance: CleanupInstance): string {
  return instance.stateDir ?? dirname(dirname(instance.journal));
}

function realDirectory(path: string): string | undefined {
  try {
    if (!lstatSync(path).isDirectory()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The state directories one sweep covers: the canonical harness, every direct
 * sibling `<host>/.devboard/.tmp`, and every live dashboard's real state
 * directory (derived from its journal, never from the serving package).
 * De-duplicated by real path; a symlinked `.tmp` is never followed.
 */
export function coveredStateDirs(
  root: string,
  instances: CleanupInstance[] = [],
): CoveredStateDir[] {
  const covered: CoveredStateDir[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: CleanupSource): void => {
    const real = realDirectory(path);
    if (real === undefined || seen.has(real)) return;
    seen.add(real);
    covered.push({ stateDir: real, source });
  };

  add(join(root, ".devboard", ".tmp"), "canonical");

  let names: string[] = [];
  try {
    names = readdirSync(dirname(root)).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    add(join(dirname(root), name, ".devboard", ".tmp"), "sibling");
  }
  for (const instance of instances) add(stateDirectory(instance), "instance");

  return covered;
}

/** True when a lock file's name records a pid that is still alive. */
function liveLegacyLock(path: string): boolean {
  const match = /^devboard-(\d+)\.lock$/.exec(path.slice(path.lastIndexOf(sep) + 1));
  if (match === null) return false;
  return existsSync(`/proc/${match[1]}`);
}

function inside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  return rest.length > 0 && rest !== ".." && !rest.startsWith(`..${sep}`) && !rest.startsWith(sep);
}

interface SweepOptions {
  now: Date;
  dryRun: boolean;
  watchdogRunDir?: string;
}

/**
 * One state directory. Every file or symlink older than the cutoff is a
 * candidate; a directory is one when it would be empty and its own mtime, read
 * before any deletion, is older. Protected paths are never even descended into.
 */
export function sweepStateDir(
  stateDir: string,
  options: SweepOptions,
): CleanupRootReport {
  const cutoff = options.now.getTime() - CLEANUP_RETENTION_MS;
  const errors: string[] = [];
  const candidates: CleanupCandidate[] = [];
  const report: CleanupRootReport = {
    stateDir,
    source: "canonical",
    candidates,
    removed: [],
    bytes: 0,
    files: 0,
    directories: 0,
    errors,
  };

  const info = realDirectory(stateDir);
  if (info === undefined) {
    errors.push("not a directory; nothing swept");
    return report;
  }
  const directory = info;
  const protectedPrefixes = [
    join(directory, "state"),
    join(directory, "journal"),
    // Every repo-scoped issues record: state, ledger, runs, activity, control,
    // and the repo-anchored lock a worker holds. A running worker's run
    // directory is therefore never swept.
    join(directory, ISSUES_DIRECTORY),
    ...(options.watchdogRunDir === undefined ? [] : [resolve(options.watchdogRunDir)]),
  ];
  const protectedExact = new Set([
    join(directory, "watchdog", "state.json"),
    join(directory, "watchdog", "latest.json"),
    join(directory, "watchdog", "lock"),
    join(directory, "orchestrator", "state.json"),
    join(directory, "orchestrator", "ledger.json"),
    join(directory, "orchestrator", "lock"),
  ]);

  const isProtected = (path: string): boolean => {
    if (protectedExact.has(path)) return true;
    if (liveLegacyLock(path)) return true;
    return protectedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}${sep}`));
  };

  const visit = (path: string): { removable: boolean; bytes: number } => {
    if (isProtected(path)) return { removable: false, bytes: 0 };
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      return { removable: false, bytes: 0 };
    }
    if (entry.isSymbolicLink()) {
      if (entry.mtimeMs < cutoff) {
        candidates.push({ path, bytes: 0, kind: "symlink" });
        return { removable: true, bytes: 0 };
      }
      return { removable: false, bytes: 0 };
    }
    if (entry.isFile()) {
      if (entry.mtimeMs < cutoff) {
        candidates.push({ path, bytes: entry.size, kind: "file" });
        return { removable: true, bytes: entry.size };
      }
      return { removable: false, bytes: 0 };
    }
    if (!entry.isDirectory()) return { removable: false, bytes: 0 };

    let names: string[] = [];
    try {
      names = readdirSync(path).sort();
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      return { removable: false, bytes: 0 };
    }
    let survivors = 0;
    let bytes = 0;
    for (const name of names) {
      const child = visit(join(path, name));
      bytes += child.bytes;
      if (!child.removable) survivors += 1;
    }
    if (survivors === 0 && entry.mtimeMs < cutoff) {
      candidates.push({ path, bytes: 0, kind: "directory" });
      return { removable: true, bytes };
    }
    return { removable: false, bytes };
  };

  let top: string[] = [];
  try {
    top = readdirSync(directory).sort();
  } catch (error) {
    errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  for (const name of top) visit(join(directory, name));

  let bytes = 0;
  for (const candidate of candidates) bytes += candidate.bytes;
  if (options.dryRun) {
    report.bytes = bytes;
    report.files = candidates.filter((candidate) => candidate.kind !== "directory").length;
    report.directories = candidates.filter((candidate) => candidate.kind === "directory").length;
    return report;
  }

  for (const candidate of candidates) {
    if (!inside(directory, candidate.path)) {
      errors.push(`${candidate.path}: refuses to delete outside ${directory}`);
      continue;
    }
    try {
      if (candidate.kind === "directory") rmdirSync(candidate.path);
      else unlinkSync(candidate.path);
      report.removed.push(candidate);
      report.bytes += candidate.bytes;
      if (candidate.kind === "directory") report.directories += 1;
      else report.files += 1;
    } catch (error) {
      errors.push(
        `${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}

/** Finds every covered state directory and sweeps each one. */
export function runCleanup(options: CleanupRunOptions): CleanupReport {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const covered = options.covered ?? coveredStateDirs(options.root, options.instances ?? []);
  const roots = covered.map((entry) => {
    const report = sweepStateDir(entry.stateDir, {
      now,
      dryRun,
      ...(options.watchdogRunDir === undefined ? {} : { watchdogRunDir: options.watchdogRunDir }),
    });
    report.source = entry.source;
    return report;
  });
  return {
    now: now.toISOString(),
    cutoff: new Date(now.getTime() - CLEANUP_RETENTION_MS).toISOString(),
    dryRun,
    roots,
  };
}
