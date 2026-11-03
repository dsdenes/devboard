import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { JOURNAL_KINDS, journalFiles, type JournalKind } from "../server/journal";
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
  /** Logical run, lane, or peer the journal record named. */
  scope?: string;
  /** Severity token an `omp-log` record carried. */
  level?: "error" | "warn" | "fatal";
  /**
   * The body an `omp-log` record carried past its message: the traceback omp
   * logged for a runner's stderr. It classifies the record and never joins the
   * quote, because a traceback differs per occurrence.
   */
  detail?: string;
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

/** In-window events of one journal file, with the identity used to merge copies. */
interface JournalFileEvidence {
  events: EvidenceEvent[];
  /** Record identity parallel to `events`. */
  identities: string[];
  malformed: number;
}

/**
 * Reads one JSONL journal file. Records inside the window are returned;
 * malformed records are counted, never guessed. An unreadable file is empty.
 */
function readJournalFile(
  path: string,
  options: WindowOptions & { root: string },
  instance: Instance,
): JournalFileEvidence {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return { events: [], identities: [], malformed: 0 };
  }
  const events: EvidenceEvent[] = [];
  const identities: string[] = [];
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
    const scope = typeof record.scope === "string" && record.scope.length > 0 ? record.scope : "";
    events.push({
      source: normalizedPath(options.root, path),
      kind,
      ts: new Date(ts).toISOString(),
      text: record.text,
      ...(scope.length > 0 ? { scope } : {}),
      instance,
    });
    identities.push(JSON.stringify([ts, kind, scope, record.text]));
  }
  return { events, identities, malformed };
}

/**
 * Reads one project's JSONL journal, live and rotated. The files are the
 * serving harness's, so a dashboard from another checkout contributes its own
 * records. Rotated journals are read oldest first, and a record present in
 * both a rotated file and the live one is counted once: rotation moves records
 * rather than copying them, so a copy is the same record. Malformed records
 * count across every file read.
 */
export function readJournalEvidence(
  instance: Instance,
  options: WindowOptions & { root: string },
): { events: EvidenceEvent[]; malformed: number } {
  const events: EvidenceEvent[] = [];
  let malformed = 0;
  /** Most occurrences of one identity any earlier file held. */
  const seen = new Map<string, number>();
  for (const path of journalFiles(instance.journal, options.window.start)) {
    const file = readJournalFile(path, options, instance);
    malformed += file.malformed;
    const occurrences = new Map<string, number>();
    file.events.forEach((event, index) => {
      const identity = file.identities[index] ?? "";
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      // Copies beyond what an earlier file already held are the same record.
      if (occurrence < (seen.get(identity) ?? 0)) return;
      events.push(event);
    });
    for (const [identity, count] of occurrences) {
      seen.set(identity, Math.max(seen.get(identity) ?? 0, count));
    }
  }
  return { events, malformed };
}

export interface ProcessInfo {
  /** Process ids from the parent upward, nearest first. */
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

/**
 * An omp line belongs to an instance only when its pid descends from that
 * dashboard's server process. A shared working directory never attributes a
 * line: an operator's own omp session in the project runs from the same
 * directory while being unrelated to the dashboard, and its warnings are not
 * dashboard evidence.
 */
function attribution(
  pid: number,
  instance: Instance[],
  processInfo: (pid: number) => ProcessInfo | undefined,
): Instance | undefined {
  const info = processInfo(pid);
  if (info === undefined) return undefined;
  return instance.find((candidate) => info.ancestors.includes(candidate.pid));
}

/**
 * Reads omp's own process logs. A line is evidence for an instance only when
 * its pid descends from that instance's server; a shared working directory
 * never attributes a line, and the watchdog's own pids never become evidence.
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
      return snapshot === undefined ? undefined : { ancestors: snapshot.ancestors };
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
        detail: typeof record.text === "string" ? record.text : undefined,
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

/**
 * An evidence line without its timestamp, its per-occurrence capture pointer,
 * or incidental whitespace. omp appends the path of the HTTP capture it wrote
 * for one request to an error it logs; that path names one occurrence, never
 * the signal, so repeated occurrences of one failure keep one identity.
 */
export function normalizeEvidenceLine(text: string): string {
  return text
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+/, "")
    .replace(/\s*\braw-http-request=\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
