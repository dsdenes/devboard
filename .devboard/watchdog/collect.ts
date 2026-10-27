import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { JOURNAL_KINDS, type JournalKind } from "../server/journal";
import { processSnapshot, type Instance } from "./discovery";

/** The evidence window is the ten minutes before cycle start, both ends inclusive. */
export const WINDOW_MS = 10 * 60 * 1000;

export interface Window {
  start: Date;
  end: Date;
}

export interface EvidenceEvent {
  /** File the evidence came from. */
  source: string;
  /** A journal kind, or `omp-log` for omp's own process log. */
  kind: string;
  /** ISO timestamp used for the window decision. */
  ts: string;
  text: string;
  /** Severity token an `omp-log` record carried. */
  level?: "error" | "warn" | "fatal";
  /** Project the evidence belongs to, when attribution resolved it. */
  instance?: Instance;
}

export interface Collection {
  events: EvidenceEvent[];
  /** Records with an unparseable timestamp or malformed shape. */
  malformed: number;
  /** omp log lines outside every instance's working tree. */
  unattributed: number;
}

export interface WindowOptions {
  window: Window;
}

/** Returns the parsed instant, or undefined when the timestamp is unusable. */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedPath(root: string, path: string): string {
  const resolved = resolve(path);
  const local = relative(resolve(root), resolved);
  return local.length === 0 || local.startsWith("..") ? resolved : local;
}

/**
 * Reads one project's JSONL journal. The file is the serving harness's, so a
 * dashboard from another checkout contributes its own records. Records inside
 * the window are returned; malformed records are counted, never guessed.
 */
export function readJournalEvidence(
  instance: Instance,
  options: WindowOptions & { root: string },
): { events: EvidenceEvent[]; malformed: number } {
  let source: string;
  try {
    source = readFileSync(instance.journal, "utf8");
  } catch {
    return { events: [], malformed: 0 };
  }
  const events: EvidenceEvent[] = [];
  let malformed = 0;
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      record = parsed as Record<string, unknown>;
    } catch {
      malformed += 1;
      continue;
    }
    const ts = parseTimestamp(record.ts);
    if (ts === undefined) {
      malformed += 1;
      continue;
    }
    if (ts < options.window.start.getTime() || ts > options.window.end.getTime()) continue;
    const kind = record.kind;
    if (typeof kind !== "string" || !JOURNAL_KINDS.includes(kind as JournalKind)) continue;
    if (typeof record.text !== "string") continue;
    events.push({
      source: normalizedPath(options.root, instance.journal),
      kind,
      ts: new Date(ts).toISOString(),
      text: record.text,
      instance,
    });
  }
  return { events, malformed };
}

export interface ProcessInfo {
  cwd?: string;
  ancestors: number[];
}

export interface OmpOptions extends WindowOptions {
  logsDir?: string;
  instances: Instance[];
  /** Pids of the watchdog and its descendants. */
  selfPids: Set<number>;
  /** Injectable process lookup; defaults to `/proc`. */
  processInfo?: (pid: number) => ProcessInfo | undefined;
}

interface OmpRecord {
  timestamp?: unknown;
  level?: unknown;
  pid?: unknown;
  message?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

function describeOmpLine(record: OmpRecord): string {
  const parts = [record.message, record.error]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ");
  return parts.length > 0 ? parts : JSON.stringify(record);
}

function attribution(
  pid: number,
  instance: Instance[],
  processInfo: (pid: number) => ProcessInfo | undefined,
): Instance | undefined {
  const info = processInfo(pid);
  if (info === undefined) return undefined;
  const cwd = info.cwd === undefined ? undefined : resolve(info.cwd);
  return instance.find(
    (candidate) =>
      (cwd !== undefined && resolve(candidate.repoDir) === cwd) ||
      info.ancestors.includes(candidate.pid),
  );
}

/**
 * Reads omp's own process logs. A line is evidence for an instance only when
 * its pid worked in that instance's project or descends from that instance's
 * server; the watchdog's own pids never become evidence.
 */
export function readOmpEvidence(options: OmpOptions): {
  events: EvidenceEvent[];
  malformed: number;
  unattributed: number;
} {
  const logsDir = options.logsDir ?? join(homedir(), ".omp", "logs");
  const processInfo =
    options.processInfo ??
    ((pid: number) => {
      const snapshot = processSnapshot(pid);
      return snapshot === undefined
        ? undefined
        : { cwd: snapshot.cwd, ancestors: snapshot.ancestors };
    });
  let names: string[];
  try {
    names = readdirSync(logsDir).filter((name) => /^omp\..*\.log$/.test(name));
  } catch {
    return { events: [], malformed: 0, unattributed: 0 };
  }
  let malformed = 0;
  let unattributed = 0;
  const events: EvidenceEvent[] = [];
  for (const name of names) {
    const path = join(logsDir, name);
    try {
      if (statSync(path).mtimeMs < options.window.start.getTime()) continue;
    } catch {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of source.split("\n")) {
      if (line.trim().length === 0) continue;
      let record: OmpRecord;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        record = parsed as OmpRecord;
      } catch {
        malformed += 1;
        continue;
      }
      const ts = parseTimestamp(record.timestamp);
      if (ts === undefined) {
        malformed += 1;
        continue;
      }
      if (ts < options.window.start.getTime() || ts > options.window.end.getTime()) continue;
      const level = typeof record.level === "string" ? record.level.toLowerCase() : "";
      if (level !== "error" && level !== "warn" && level !== "fatal") continue;
      const pid = Number(record.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        malformed += 1;
        continue;
      }
      if (options.selfPids.has(pid)) continue;
      const ancestors = processInfo(pid)?.ancestors ?? [];
      if (ancestors.some((ancestor) => options.selfPids.has(ancestor))) continue;
      const owner = attribution(pid, options.instances, processInfo);
      if (owner === undefined) {
        unattributed += 1;
        continue;
      }
      events.push({
        source: path,
        kind: "omp-log",
        ts: new Date(ts).toISOString(),
        text: describeOmpLine(record),
        level,
        instance: owner,
      });
    }
  }
  return { events, malformed, unattributed };
}

export interface CollectOptions extends WindowOptions {
  root: string;
  instances: Instance[];
  selfPids: Set<number>;
  logsDir?: string;
  processInfo?: (pid: number) => ProcessInfo | undefined;
}

/** Collects the journal and omp evidence for one cycle window. */
export function collectEvidence(options: CollectOptions): Collection {
  const events: EvidenceEvent[] = [];
  let malformed = 0;
  for (const instance of options.instances) {
    const journal = readJournalEvidence(instance, options);
    events.push(...journal.events);
    malformed += journal.malformed;
  }
  const omp = readOmpEvidence(options);
  events.push(...omp.events);
  malformed += omp.malformed;
  return { events, malformed, unattributed: omp.unattributed };
}

/** An evidence line without its timestamp or incidental whitespace. */
export function normalizeEvidenceLine(text: string): string {
  return text
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
