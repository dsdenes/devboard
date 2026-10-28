import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The dashboard journal is the machine-readable record the watchdog reads.
 * One file per project per harness, appended as JSON lines so a truncated tail
 * costs at most one record. Writes never interrupt a run: a full disk or a
 * read-only state directory only produces a line on the server's stderr.
 */

export const JOURNAL_KINDS = [
  "activity",
  "question",
  "run-start",
  "run-stop",
  "lane-start",
  "lane-stop",
  "lifecycle",
  "acp-stderr",
  "server-error",
  "update",
  "update-error",
] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** A live journal rotates at this size instead of growing without bound. */
export const JOURNAL_ROTATE_BYTES = 8 * 1024 * 1024;
/** Rotated journals older than this leave at cycle start. */
export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Total journal bytes the watchdog keeps, unless the live window is larger. */
export const JOURNAL_MAX_BYTES = 1024 * 1024 * 1024;

export interface JournalRecord {
  /** UTC ISO 8601 timestamp of the record. */
  ts: string;
  /** Absolute project path the server serves. */
  repo: string;
  port: number;
  pid: number;
  kind: JournalKind;
  text: string;
  /** Logical run, lane, or peer the record belongs to, when one is known. */
  scope?: string;
}

export interface JournalOptions {
  /** Harness state directory; the journal lives in its `journal` child. */
  stateDir: string;
  repoDir: string;
  port: number;
  pid?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Size at which the live file is rotated aside. */
  rotateBytes?: number;
  /** Injectable append, used to simulate a write failure. */
  append?: (path: string, data: string) => void;
  /** Injectable failure sink; defaults to the server's stderr. */
  reportError?: (message: string) => void;
}

export interface Journal {
  path: string;
  write(kind: JournalKind, text: string, scope?: string): void;
}

/** The 24-hex project key that names this project's journal. */
export function journalKey(repoDir: string): string {
  return createHash("sha256").update(repoDir).digest("hex").slice(0, 24);
}

export function journalFile(stateDir: string, repoDir: string): string {
  return join(stateDir, "journal", `${journalKey(repoDir)}.jsonl`);
}

/**
 * A journal filename: `<24-hex project key>.jsonl`, rotated aside as
 * `<key>.jsonl.<rotation instant>-<counter>`. Rotation and pruning share this
 * one definition so a name the writer produces is a name the pruner accepts.
 */
const JOURNAL_NAME = /^([0-9a-f]{24})\.jsonl(?:\.(\d+)-(\d+))?$/;

interface JournalName {
  /** The project key that names the journal. */
  key: string;
  /** Rotation instant and counter; absent on the live journal. */
  rotation?: { ms: number; counter: number };
}

/** Parses a journal filename; `null` for any other file in the directory. */
function parseJournalName(name: string): JournalName | null {
  const match = JOURNAL_NAME.exec(name);
  if (match === null) return null;
  const key = match[1];
  const ms = match[2];
  const counter = match[3];
  if (key === undefined) return null;
  if (ms === undefined || counter === undefined) return { key };
  return { key, rotation: { ms: Number(ms), counter: Number(counter) } };
}

/**
 * Every journal file of one project: rotated journals oldest first, then the
 * live file. A project that never rotated yields only its live path, and a
 * missing journal directory yields that path so the read reports nothing.
 *
 * `since` is the oldest instant a caller needs. A rotated file last written
 * before it cannot hold a later record, so it is skipped instead of parsed:
 * a quiet dashboard keeps up to `JOURNAL_MAX_BYTES` of old rotations.
 */
export function journalFiles(livePath: string, since?: Date): string[] {
  const directory = dirname(livePath);
  const live = parseJournalName(basename(livePath));
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [livePath];
  }
  if (live === null) return [livePath];
  const cutoff = since?.getTime();
  const rotated: { path: string; ms: number; counter: number; name: string }[] = [];
  for (const name of names) {
    const parsed = parseJournalName(name);
    if (parsed === null || parsed.rotation === undefined) continue;
    if (parsed.key !== live.key) continue;
    const { ms, counter } = parsed.rotation;
    const path = join(directory, name);
    if (cutoff !== undefined) {
      try {
        if (statSync(path).mtimeMs < cutoff) continue;
      } catch {
        // A journal disappearing mid-scan is already gone.
        continue;
      }
    }
    rotated.push({ path, ms, counter, name });
  }
  rotated.sort(
    (left, right) =>
      left.ms - right.ms || left.counter - right.counter || left.name.localeCompare(right.name),
  );
  return [...rotated.map((file) => file.path), livePath];
}

/** One JSONL line per event, truncated so a single huge stream cannot flood it. */
export function journalLine(record: JournalRecord): string {
  const text = record.text.length > 2000 ? `${record.text.slice(0, 2000)}…` : record.text;
  return `${JSON.stringify({ ...record, text })}\n`;
}

export function openJournal(options: JournalOptions): Journal {
  const path = journalFile(options.stateDir, options.repoDir);
  const append = options.append ?? ((target: string, data: string) => appendFileSync(target, data));
  const reportError =
    options.reportError ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const rotateBytes = options.rotateBytes ?? JOURNAL_ROTATE_BYTES;
  const pid = options.pid ?? process.pid;
  let opened = false;
  let size = 0;
  let rotations = 0;
  let reported = false;

  // A dashboard that has not emitted an event yet is still instrumented.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // The first write reports the failure through the configured sink.
  }

  function open() {
    if (opened) return;
    mkdirSync(dirname(path), { recursive: true });
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    opened = true;
  }

  /** Moves the live file aside so no record is ever truncated away. */
  function rotate() {
    rotations += 1;
    // A counter keeps two rotations in the same millisecond from colliding.
    renameSync(path, `${path}.${Date.now()}-${rotations}`);
    size = 0;
  }

  return {
    path,
    write(kind: JournalKind, text: string, scope?: string) {
      const record: JournalRecord = {
        ts: (options.now?.() ?? new Date()).toISOString(),
        repo: options.repoDir,
        port: options.port,
        pid,
        kind,
        text,
        ...(scope === undefined ? {} : { scope }),
      };
      const line = journalLine(record);
      const bytes = Buffer.byteLength(line);
      try {
        open();
        if (size > 0 && size + bytes > rotateBytes) rotate();
        append(path, line);
        size += bytes;
      } catch (error) {
        if (reported) return;
        reported = true;
        const detail = error instanceof Error ? error.message : String(error);
        reportError(`journal: could not write ${path}: ${detail}`);
      }
    },
  };
}

export interface PruneOptions {
  /** Cycle start; the live evidence window ends here. */
  now: Date;
  /** Oldest timestamp the watchdog still needs. */
  windowStart: Date;
  retentionMs?: number;
  maxBytes?: number;
}

interface JournalFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Drops rotated journals past the retention limit and enforces the total bound
 * by deleting the oldest complete files first. A file that still holds records
 * inside the live window is never deleted for the bound.
 */
export function pruneJournal(stateDir: string, options: PruneOptions): string[] {
  const directory = join(stateDir, "journal");
  const retentionMs = options.retentionMs ?? JOURNAL_RETENTION_MS;
  const maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const files: JournalFile[] = [];
  for (const name of names) {
    if (parseJournalName(name) === null) continue;
    const path = join(directory, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      files.push({
        path,
        name,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // A journal disappearing mid-scan is already gone.
    }
  }

  const removed: string[] = [];
  const cutoff = options.now.getTime() - retentionMs;
  const windowStart = options.windowStart.getTime();
  const remaining = new Set(files);

  for (const file of [...files].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (!remaining.has(file)) continue;
    if (file.mtimeMs >= cutoff) continue;
    try {
      unlinkSync(file.path);
      remaining.delete(file);
      removed.push(file.name);
    } catch {
      // A concurrent reader may already have removed it.
    }
  }

  let total = [...remaining].reduce((sum, file) => sum + file.size, 0);
  for (const file of [...remaining].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= maxBytes) break;
    // A file still inside the window is evidence the next cycle needs.
    if (file.mtimeMs >= windowStart) continue;
    try {
      unlinkSync(file.path);
      remaining.delete(file);
      total -= file.size;
      removed.push(file.name);
    } catch {
      // Already gone.
    }
  }

  return removed;
}
